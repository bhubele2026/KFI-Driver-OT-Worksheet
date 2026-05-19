import * as XLSX from "xlsx";
import { Type } from "@google/genai";
import { logger } from "../logger.js";
import { getGeminiClient } from "./gemini.js";
import { toDisplayName } from "./displayName.js";
import { ocrDelalloPDF } from "./ocr.js";
import { UnmappedIdAccumulator } from "./types.js";

export interface AiExtractedRow {
  driverNameOnDoc: string;
  badgeOrId?: string | null;
  date: string; // YYYY-MM-DD
  timeIn?: string | null; // "H:MM AM/PM"
  timeOut?: string | null; // "H:MM AM/PM"
  hours?: number | null;
  /**
   * Optional KFI id the model picked when it was confident the row's
   * driver matches one of the roster entries supplied in the prompt
   * (see `RosterContext`). Treated as a HINT only — the server still
   * cross-checks against badge mappings and refuses the AI pick when
   * it disagrees with an existing badge → kfi mapping (Task #271).
   * Null/omitted when the AI wasn't confident.
   */
  resolvedKfiId?: string | null;
}

/**
 * Roster context passed into the AI prompt so the model can attempt to
 * resolve each row to a known KFI driver instead of returning bare
 * names that the server then has to fuzzy-match. Each entry lists the
 * KFI id, the driver's canonical name, any known badge/employee ids
 * (collected from `driver_id_aliases` + `EMBEDDED_MAPPING`), and any
 * dispatcher-saved name aliases for THIS customer (so an alias like
 * "Joey C." resolves on first read after it's been taught once).
 * Task #271.
 */
export interface RosterContext {
  customer: string;
  drivers: Array<{
    kfiId: string;
    name: string;
    badges: string[];
    aliases: string[];
  }>;
}

/**
 * Coerce whatever shape Gemini returns in `date` into a strict YYYY-MM-DD
 * string. Gemini is asked for ISO dates in the prompt but routinely emits
 * `M/D/YYYY`, `MM/DD/YY`, `May 12, 2026`, ISO datetimes with timezones,
 * etc. The week-window filter downstream is a string compare, so anything
 * but YYYY-MM-DD silently drops 100% of the rows. Returns null when the
 * input genuinely can't be interpreted or is an impossible calendar date
 * (e.g. 2/30); callers count that into the `invalidDateCount` diagnostics bucket.
 *
 * `isRealCalendarDate` rejects impossible calendar dates like 2/30/2026 or
 * 13/01/2026 that the regex branches below would otherwise happily
 * reformat to a valid-looking YYYY-MM-DD string. The week-window filter
 * downstream is a string compare so an impossible date would survive —
 * better to count it as `invalidDateCount` than to silently include it.
 */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function normalizeIsoDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already YYYY-MM-DD (with or without trailing time/zone).
  let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!isRealCalendarDate(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // M/D/YYYY or MM/DD/YYYY (US-formatted).
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const y = parseInt(m[3], 10);
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (!isRealCalendarDate(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // M/D/YY (assume 2000s).
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const y = 2000 + parseInt(m[3], 10);
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (!isRealCalendarDate(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // Last resort: let the Date constructor try. Use the UTC slice to
  // avoid local-tz day flips for inputs like "May 12 2026". For non-ISO
  // strings the Date constructor silently rolls invalid dates (e.g.
  // "February 30, 2026" becomes March 2), so we cross-check the parsed
  // month/day against the original string to reject rollovers.
  const dt = new Date(trimmed);
  if (!isNaN(dt.getTime())) {
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const dy = dt.getUTCDate();
    if (!isRealCalendarDate(y, mo, dy)) return null;
    const months = [
      "jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    const lower = trimmed.toLowerCase();
    const monthIdx = dt.getUTCMonth();
    for (let i = 0; i < 12; i++) {
      if (lower.includes(months[i]) && i !== monthIdx) return null;
    }
    if (!trimmed.includes(String(dy))) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
  }
  return null;
}

const ROW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    rows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          driverNameOnDoc: { type: Type.STRING },
          badgeOrId: { type: Type.STRING },
          date: { type: Type.STRING },
          timeIn: { type: Type.STRING },
          timeOut: { type: Type.STRING },
          hours: { type: Type.NUMBER },
          resolvedKfiId: { type: Type.STRING },
        },
        required: ["driverNameOnDoc", "date"],
      },
    },
  },
  required: ["rows"],
};

// Threshold above which we stop sending the entire workbook in one
// Gemini call and instead split into row-range chunks (Task #255).
// Below this the single-call path is materially cheaper (one round trip,
// one prompt overhead). Above it Gemini reliably hits maxOutputTokens
// mid-row on weekly customer exports, so chunking pays off even with
// the extra round trips. Each chunk re-includes the sheet header so
// Gemini can interpret columns without seeing the whole spreadsheet.
export const XLSX_CHUNK_THRESHOLD_CHARS = 300_000;
// Row-count trigger (Task #264). The real bottleneck is OUTPUT tokens,
// not input chars: Task #261's "one row per source line" prompt tripled
// per-row output verbosity, so a 522-row Penda export (well under the
// 300k char input trigger) was busting the 32k output-token cap mid-row
// and silently dropping ~95% of the rows. We now force chunking once
// the workbook exceeds this many data rows regardless of total chars,
// keeping each chunk's worst-case JSON output well under 32k tokens.
export const XLSX_CHUNK_THRESHOLD_ROWS = 100;
// Rough rows-per-chunk target. The chunker measures by chars (so wide
// columns produce smaller chunks than narrow ones) but caps row count
// as a safety net for pathologically wide rows. Sized to keep each
// chunk's JSON output under ~10k tokens AND each chunk's wall-clock
// well under the per-chunk 120s ceiling — Task #267 dropped this from
// 150 to 100 after Penda (522 rows ÷ 150 = 4 chunks) had one chunk
// regularly hit the 120s timeout on verbose pay-category-split shifts.
// At 100 rows/chunk Penda becomes ~6 chunks of 30-60s each, which the
// parallel runner below finishes in roughly the time of one chunk.
const XLSX_CHUNK_MAX_CHARS = 250_000;
const XLSX_CHUNK_MAX_ROWS = 100;

/**
 * Split a workbook into one-or-more CSV chunks suitable for separate
 * Gemini calls. Each chunk is self-describing: it begins with a
 * `# Sheet: …` marker and the header row from that sheet, so the model
 * can interpret the columns without seeing the rest of the workbook.
 *
 * Returns a single-element array when the workbook fits under
 * `XLSX_CHUNK_THRESHOLD_CHARS` — callers shouldn't pay the multi-RT
 * cost for small files.
 */
export function xlsxToChunks(
  buffer: Buffer,
  log?: SalvageLogger,
  opts?: { forceChunkMaxRows?: number },
): string[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  // Per-sheet CSV breakdowns, computed once so we can decide single-vs-multi
  // based on EITHER the total char count OR the total data-row count.
  const perSheet = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return null;
    const rows = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).split("\n");
    if (rows.length === 0) return null;
    return { name, header: rows[0], body: rows.slice(1) };
  }).filter((s): s is { name: string; header: string; body: string[] } => s !== null);

  const single = perSheet
    .map((s) => `# Sheet: ${s.name}\n${s.header}\n${s.body.join("\n")}`)
    .join("\n");
  const totalBodyRows = perSheet.reduce((n, s) => n + s.body.length, 0);
  const forced = opts?.forceChunkMaxRows;

  // Total-size shortcut: small workbook AND row count under the trigger →
  // single chunk that mirrors the pre-Task-#255 single-call prompt shape
  // (preserves cost for the overwhelmingly common case where a weekly
  // export fits comfortably). The row-count trigger is what kills the
  // Task #264 "Penda silently truncates" failure mode.
  if (
    !forced &&
    single.length <= XLSX_CHUNK_THRESHOLD_CHARS &&
    totalBodyRows <= XLSX_CHUNK_THRESHOLD_ROWS
  ) {
    return [single];
  }

  const maxRowsPerChunk = forced ?? XLSX_CHUNK_MAX_ROWS;
  const chunks: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).split("\n");
    if (rows.length === 0) continue;
    const header = rows[0];
    const body = rows.slice(1);
    let i = 0;
    let part = 1;
    while (i < body.length) {
      const sliceRows: string[] = [];
      let chars = header.length + 1;
      while (i < body.length && sliceRows.length < maxRowsPerChunk) {
        const r = body[i];
        if (chars + r.length + 1 > XLSX_CHUNK_MAX_CHARS && sliceRows.length > 0) {
          break;
        }
        sliceRows.push(r);
        chars += r.length + 1;
        i++;
      }
      chunks.push(
        [
          `# Sheet: ${name} (part ${part}, rows ${i - sliceRows.length + 1}-${i})`,
          header,
          ...sliceRows,
        ].join("\n"),
      );
      part++;
    }
  }
  log?.warn(
    {
      totalChars: single.length,
      chunkCount: chunks.length,
      threshold: XLSX_CHUNK_THRESHOLD_CHARS,
    },
    "xlsx CSV exceeded chunk threshold — splitting into per-chunk Gemini calls",
  );
  return chunks;
}

function buildPrompt(
  customer: string,
  weekStart: string,
  weekEnd: string,
  roster?: RosterContext,
) {
  const lines = [
    `You are extracting timecard punches from a payroll export uploaded for customer "${customer}".`,
    `The week being reconciled is ${weekStart} through ${weekEnd} (Sunday through Saturday). Only return rows whose date falls in that window.`,
    `For each punch row return:`,
    `- driverNameOnDoc: the worker's name as written in the document (preserve casing exactly).`,
    `- badgeOrId: any employee/badge/payroll id shown for that worker (string of digits or alphanum), or omit.`,
    `- date: the punch date as YYYY-MM-DD. Resolve year from the week window if the document only shows MM/DD.`,
    `- timeIn / timeOut: clock in/out as "H:MM AM" or "H:MM PM". Omit if the document only shows total hours.`,
    `- hours: the daily worked hours as a decimal number when shown (e.g. 8.50). Omit if not present.`,
    `- resolvedKfiId: ONLY set this when you are confident the row's worker matches one of the KNOWN DRIVERS listed below — either an exact badge match, an exact alias match (case-insensitive), or the names are clearly the same person (e.g. "J. Smith" → "John Smith" when no other "Smith" is in the list). When in doubt, leave it null/omitted and the dispatcher will pick the driver. Setting the wrong id silently misroutes payroll, so prefer omission over guessing.`,
    `CRITICAL: Return one output row for EVERY non-empty data row in the document. Do NOT merge, sum, or combine multiple rows for the same driver/date — even when pay-category columns (e.g. "Reg", "OT 1.5", "SHIFT PREM", "PREM-NIGHT") split one shift across several lines, emit each line as its own output row exactly as it appears. The caller deduplicates downstream; your job is faithful row-by-row transcription.`,
    `The ONLY lines to skip are: column headers, completely blank rows, page footers/signatures, and grand-total / subtotal rows that have no driver name. When in doubt, include the row.`,
    `Do not invent rows that aren't in the document.`,
    `Return strictly JSON matching the provided schema.`,
  ];
  if (roster && roster.drivers.length > 0) {
    lines.push("");
    lines.push(
      `KNOWN DRIVERS for customer "${roster.customer}". Use resolvedKfiId to point a row at one of these when you're confident:`,
    );
    // Cap to avoid blowing the prompt on giant rosters; the per-customer
    // pool we pass is already trimmed to plausible candidates (this-week
    // Connecteam clock-ins + saved aliases) so 200 is generous headroom.
    const cap = 200;
    for (const d of roster.drivers.slice(0, cap)) {
      const parts: string[] = [`${d.kfiId}: ${d.name}`];
      if (d.badges.length > 0) parts.push(`badges=[${d.badges.join(", ")}]`);
      if (d.aliases.length > 0)
        parts.push(`aliases=[${d.aliases.join(", ")}]`);
      lines.push(`- ${parts.join("; ")}`);
    }
    if (roster.drivers.length > cap) {
      lines.push(`- (${roster.drivers.length - cap} more drivers omitted)`);
    }
  }
  return lines.join("\n");
}

/**
 * Server-side dedupe applied to merged AI rows BEFORE downstream
 * resolution. The prompt deliberately asks Gemini to emit one row per
 * non-empty data row (so it stops dropping "OT" and "PREM" pay-category
 * splits on Trienda/Kronos exports), which means a single driver-shift
 * can come back as N rows differing only by pay-category column. We
 * collapse those here.
 *
 * Key: `(lower(name)+'|'+lower(badge), date, timeIn||'', timeOut||'')`.
 * - When both clock times are present: first-wins (these are real
 *   duplicates — same shift, different pay buckets). Hours from
 *   subsequent matches are discarded; the hours engine recomputes
 *   from clock times anyway.
 * - When BOTH clock times are absent on every duplicate (pure
 *   hours-only export — rare): hours are summed across the bucket so a
 *   row like "Reg 32 / OT 8" still totals to 40 instead of 32.
 */
function normalizeTimeForKey(t: string | null | undefined): string {
  // Collapse "06:00 am", " 6:00 AM ", "6:00AM" all to "6:00 AM" so
  // pay-category split rows that differ only in formatting still
  // collide on the same key. Returns empty string for null/blank.
  if (!t) return "";
  const m = t
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .match(/^0?(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!m) return t.trim().toUpperCase();
  return `${parseInt(m[1], 10)}:${m[2]} ${m[3]}`;
}

export function dedupeAiRows(rows: AiExtractedRow[]): AiExtractedRow[] {
  const byKey = new Map<string, AiExtractedRow>();
  for (const r of rows) {
    const name = (r.driverNameOnDoc ?? "").trim().toLowerCase();
    const badge = (r.badgeOrId ?? "").trim().toLowerCase();
    // Normalize date to YYYY-MM-DD so a single shift split across pay
    // categories with date emitted as "5/12/2026" on one line and
    // "2026-05-12" on another still collides on the same key. Falls back
    // to the raw string for genuinely unparseable inputs.
    const isoDate = normalizeIsoDate(r.date) ?? (r.date ?? "").trim();
    const tIn = normalizeTimeForKey(r.timeIn);
    const tOut = normalizeTimeForKey(r.timeOut);
    const key = `${name}|${badge}::${isoDate}::${tIn}::${tOut}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    // Duplicate with clock times → first wins, drop the rest.
    if (tIn || tOut) continue;
    // Hours-only duplicate → sum hours so split-by-pay-category exports
    // still total correctly.
    const prevHours = typeof prev.hours === "number" ? prev.hours : 0;
    const addHours = typeof r.hours === "number" ? r.hours : 0;
    if (prevHours || addHours) {
      prev.hours = prevHours + addHours;
    }
  }
  return Array.from(byKey.values());
}

/**
 * Parse the model's JSON response, with a salvage path for truncated output.
 *
 * Gemini occasionally hits maxOutputTokens mid-row on very large weekly
 * exports, returning a JSON string that's missing its trailing brackets
 * (e.g. `{"rows":[{...},{"driverNameOnDoc":"Jo`). Rather than fail the
 * entire upload — which would force the dispatcher to manually enter ~150
 * punches — we trim back to the last complete row object in the `rows`
 * array and re-close the brackets. Any data after that point is lost, but
 * the dispatcher sees a partial preview they can confirm or re-run.
 */
/** Minimal logger shape — accepts req.log (pino child) or the module logger. */
type SalvageLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export function parseOrSalvage(
  raw: string,
  customer: string,
  fileName: string,
  log?: SalvageLogger,
): { rows?: AiExtractedRow[]; truncated: boolean } {
  try {
    const parsed = JSON.parse(raw) as { rows?: AiExtractedRow[] };
    return { ...parsed, truncated: false };
  } catch {
    // Locate the `rows` array, walk it row-by-row with a brace counter,
    // and stop at the last fully-balanced row object. Then reconstruct
    // `{"rows":[<balanced rows>]}` and parse that.
    const rowsStart = raw.indexOf("[");
    if (rowsStart === -1) {
      throw new Error(
        `AI extraction: model did not return valid JSON and could not be salvaged (no rows array).`,
      );
    }
    let i = rowsStart + 1;
    let lastGood = -1; // index just after the last balanced row obj
    let depth = 0;
    let inStr = false;
    let esc = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) lastGood = i + 1;
      }
      i++;
    }
    if (lastGood === -1) {
      throw new Error(
        `AI extraction: model response was truncated before any complete row could be recovered.`,
      );
    }
    const salvaged = `${raw.slice(0, lastGood)}]}`;
    try {
      const parsed = JSON.parse(salvaged) as { rows?: AiExtractedRow[] };
      (log ?? logger).warn(
        {
          customer,
          fileName,
          rawLen: raw.length,
          salvagedLen: salvaged.length,
          rows: parsed.rows?.length ?? 0,
        },
        "AI extraction: salvaged truncated JSON response",
      );
      return { ...parsed, truncated: true };
    } catch (err2) {
      throw new Error(
        `AI extraction: model response was truncated and salvage failed (${(err2 as Error).message}).`,
      );
    }
  }
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const doc = await mod.getDocument({
    data,
  } as Parameters<typeof mod.getDocument>[0]).promise;
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const lines = new Map<number, Array<{ x: number; t: string }>>();
      for (const item of content.items) {
        if (typeof (item as { str?: unknown }).str !== "string") continue;
        const it = item as { str: string; transform: number[] };
        const y = Math.round(it.transform[5]);
        const arr = lines.get(y) ?? [];
        arr.push({ x: it.transform[4], t: it.str });
        lines.set(y, arr);
      }
      pages.push(
        [...lines.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, items]) =>
            items
              .sort((a, b) => a.x - b.x)
              .map((i) => i.t)
              .join(" "),
          )
          .join("\n"),
      );
    }
  } finally {
    await doc.destroy();
  }
  return pages.join("\n\n").slice(0, 200_000);
}

// Test-only stub queue. When non-empty, the next `aiExtractRows` call
// pops and returns the head instead of invoking Gemini. Lets unit tests
// drive `extractImageForKnownCustomer` deterministically without an
// external dependency. Production code never touches this — there's no
// public push API except the test helper below, and it's gated on
// `NODE_ENV !== "production"` in `aiExtractRows`.
const _aiStubQueue: AiExtractedRow[][] = [];
// Parallel queue of `truncated` flags consumed alongside `_aiStubQueue`.
// Pushed via the optional second arg to `__pushAiExtractStub` so tests
// can simulate Task #264's "Gemini hit maxOutputTokens" case and verify
// the auto-rechunk / halving retry path.
const _aiStubTruncatedQueue: boolean[] = [];
// Parallel queue of per-stub errors. When the head is a non-null Error,
// the next stub consumer throws it instead of returning rows — lets the
// Task #267 partial-failure test simulate "one chunk's Gemini call blew
// up" without actually invoking Gemini.
const _aiStubErrorQueue: (Error | null)[] = [];
/** @internal test seam — push rows the next `aiExtractRows` call should return. */
export function __pushAiExtractStub(
  rows: AiExtractedRow[],
  opts?: { truncated?: boolean },
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__pushAiExtractStub is a test seam — not callable in production");
  }
  _aiStubQueue.push(rows);
  _aiStubTruncatedQueue.push(opts?.truncated ?? false);
  _aiStubErrorQueue.push(null);
}
/** @internal test seam — push an error the next chunk consumer should throw. */
export function __pushAiExtractErrorStub(message: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__pushAiExtractErrorStub is a test seam — not callable in production");
  }
  _aiStubQueue.push([]);
  _aiStubTruncatedQueue.push(false);
  _aiStubErrorQueue.push(new Error(message));
}
/** @internal test seam — clear any unused stubs (e.g. teardown). */
export function __clearAiExtractStubs(): void {
  _aiStubQueue.length = 0;
  _aiStubTruncatedQueue.length = 0;
  _aiStubErrorQueue.length = 0;
}

// Per-chunk Gemini ceiling for the chunked xlsx path. Shorter than the
// single-call 5-minute budget because each chunk is small; we still cap
// total wall-clock by stopping early if any chunk exceeds this.
const XLSX_CHUNK_TIMEOUT_MS = 120_000;

async function callGeminiForChunk(
  ai: ReturnType<typeof getGeminiClient>,
  promptText: string,
  customer: string,
  fileName: string,
  log: SalvageLogger | undefined,
): Promise<{ rows: AiExtractedRow[]; truncated: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `AI extraction timed out after ${Math.round(XLSX_CHUNK_TIMEOUT_MS / 1000)}s on one chunk — retry in a moment.`,
        ),
      );
    }, XLSX_CHUNK_TIMEOUT_MS);
  });
  const generate = ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: ROW_SCHEMA,
      maxOutputTokens: 32768,
    },
  });
  let response;
  try {
    response = await Promise.race([generate, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const raw = response.text ?? "";
  const parsed = parseOrSalvage(raw, customer, fileName, log);
  const rows = (parsed.rows ?? []).filter(
    (r) =>
      r && typeof r.driverNameOnDoc === "string" && typeof r.date === "string",
  );
  return { rows, truncated: parsed.truncated };
}

// Split a single CSV chunk's body roughly in half on truncation-retry,
// keeping the sheet header / part marker on both halves so Gemini still
// sees the column layout. Used by `runChunkedXlsxExtract` when a chunk
// busts maxOutputTokens; one halving level is enough in practice because
// our default chunk size already targets ~10k output tokens.
function halveChunk(chunk: string): [string, string] | null {
  const lines = chunk.split("\n");
  if (lines.length < 4) return null; // marker + header + at least 2 body rows
  const marker = lines[0];
  const header = lines[1];
  const body = lines.slice(2);
  const mid = Math.ceil(body.length / 2);
  const left = body.slice(0, mid);
  const right = body.slice(mid);
  if (left.length === 0 || right.length === 0) return null;
  return [
    [marker + " · half 1", header, ...left].join("\n"),
    [marker + " · half 2", header, ...right].join("\n"),
  ];
}

// Task #267: how many chunks to run in parallel. The Penda 522-row
// workbook splits into ~6 chunks; concurrency=4 finishes in roughly
// the time of one chunk's wall-clock (vs the old 6×30-60s sequential
// total that routinely tripped the 120s ceiling and killed the upload).
// Kept conservative to stay under the Gemini proxy's rate limits.
const XLSX_CHUNK_CONCURRENCY = 4;

async function runChunkedXlsxExtract(
  ai: ReturnType<typeof getGeminiClient>,
  chunks: string[],
  customer: string,
  weekStart: string,
  weekEnd: string,
  fileName: string,
  startedAt: number,
  log: SalvageLogger | undefined,
  roster?: RosterContext,
): Promise<{ rows: AiExtractedRow[]; truncated: boolean; failedChunks: number }> {
  const runOne = async (
    chunk: string,
    label: string,
  ): Promise<{ rows: AiExtractedRow[]; truncated: boolean }> => {
    // Test seam: if `__pushAiExtractStub` has been used, consume one stub
    // per request so unit tests can drive the chunked path deterministically.
    if (
      process.env.NODE_ENV !== "production" &&
      _aiStubQueue.length > 0
    ) {
      const stubbed = _aiStubQueue.shift()!;
      const truncated = _aiStubTruncatedQueue.shift() ?? false;
      const err = _aiStubErrorQueue.shift() ?? null;
      if (err) throw err;
      return {
        rows: stubbed.map((r) => ({
          ...r,
          driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
        })),
        truncated,
      };
    }
    const prompt =
      buildPrompt(customer, weekStart, weekEnd, roster) +
      `\n\n${label} of the same workbook. Return only the rows in this chunk.\n\n--- SPREADSHEET (CSV) ---\n${chunk}\n--- END SPREADSHEET ---`;
    const { rows, truncated } = await callGeminiForChunk(
      ai,
      prompt,
      customer,
      fileName,
      log,
    );
    return {
      rows: rows.map((r) => ({
        ...r,
        driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
      })),
      truncated,
    };
  };

  // Top-level per-chunk worker: handles a chunk's full lifecycle
  // (call Gemini → if truncated, halve and retry → if either step
  // throws, log + report failed so the upload as a whole survives).
  // Non-fatal per-chunk failure is the core of Task #267: before this
  // a single chunk timeout aborted the entire upload, which is what
  // killed the Penda demo case.
  const handleChunk = async (
    idx: number,
  ): Promise<{ rows: AiExtractedRow[]; truncated: boolean; failed: boolean }> => {
    try {
      const result = await runOne(
        chunks[idx],
        `This is chunk ${idx + 1} of ${chunks.length}`,
      );
      if (!result.truncated) {
        return { rows: result.rows, truncated: false, failed: false };
      }
      // Truncation: chunk still exceeded the 32k output-token cap.
      // Halve and retry the two halves in parallel. Each half failure
      // is also non-fatal — we keep whatever rows survive.
      const halves = halveChunk(chunks[idx]);
      if (!halves) {
        return { rows: result.rows, truncated: true, failed: false };
      }
      (log ?? logger).warn(
        { customer, fileName, chunk: idx + 1 },
        "AI chunk response truncated — halving and retrying",
      );
      const halfResults = await Promise.all(
        halves.map((h, hIdx) =>
          runOne(
            h,
            `This is chunk ${idx + 1}.${hIdx + 1} of ${chunks.length} (halved retry)`,
          ).catch((err: unknown) => {
            (log ?? logger).warn(
              {
                customer,
                fileName,
                chunk: idx + 1,
                half: hIdx + 1,
                err: err instanceof Error ? err.message : String(err),
              },
              "AI halved-retry chunk failed — continuing without it",
            );
            return { rows: [], truncated: false, failed: true } as {
              rows: AiExtractedRow[];
              truncated: boolean;
              failed?: boolean;
            };
          }),
        ),
      );
      const collected: AiExtractedRow[] = [];
      let anyHalfTruncated = false;
      let anyHalfFailed = false;
      for (const hr of halfResults) {
        for (const r of hr.rows) collected.push(r);
        if (hr.truncated) anyHalfTruncated = true;
        if ((hr as { failed?: boolean }).failed) anyHalfFailed = true;
      }
      return {
        rows: collected,
        truncated: anyHalfTruncated,
        failed: anyHalfFailed,
      };
    } catch (err) {
      (log ?? logger).warn(
        {
          customer,
          fileName,
          chunk: idx + 1,
          err: err instanceof Error ? err.message : String(err),
        },
        "AI chunk failed — continuing with surviving chunks",
      );
      return { rows: [], truncated: false, failed: true };
    }
  };

  // Bounded-concurrency worker pool. Preserves document order in the
  // results array (so the merged output mirrors the chunk order, which
  // matters for the schema-cache recorder downstream).
  const results = new Array<{
    rows: AiExtractedRow[];
    truncated: boolean;
    failed: boolean;
  }>(chunks.length);
  let nextIdx = 0;
  const workerCount = Math.min(XLSX_CHUNK_CONCURRENCY, chunks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= chunks.length) break;
      results[idx] = await handleChunk(idx);
    }
  });
  await Promise.all(workers);

  const merged: AiExtractedRow[] = [];
  let anyTruncated = false;
  let failedChunks = 0;
  for (const r of results) {
    for (const row of r.rows) merged.push(row);
    if (r.truncated) anyTruncated = true;
    if (r.failed) {
      failedChunks++;
      // A failed chunk means we don't have all the rows — surface that
      // to the dispatcher via the same banner as a true truncation so
      // they review carefully before confirming.
      anyTruncated = true;
    }
  }
  const deduped = dedupeAiRows(merged);
  logger.info(
    {
      ms: Date.now() - startedAt,
      aiRawRowCount: merged.length,
      aiDedupedRowCount: deduped.length,
      chunks: chunks.length,
      concurrency: workerCount,
      truncated: anyTruncated,
      failedChunks,
      customer,
      fileName,
    },
    "AI extraction complete (chunked)",
  );
  return { rows: deduped, truncated: anyTruncated, failedChunks };
}

export async function aiExtractRows(
  fileName: string,
  buffer: Buffer,
  customer: string,
  weekStart: string,
  weekEnd: string,
  mimeType?: string,
  log?: SalvageLogger,
  roster?: RosterContext,
): Promise<{ rows: AiExtractedRow[]; truncated: boolean; failedChunks: number }> {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isImage =
    (mimeType && /^image\//i.test(mimeType)) ||
    /\.(jpg|jpeg|png|webp)$/i.test(lower);
  // Test stub seam: image + pdf paths consume a single stub here so
  // `imageSupport.test.ts` can drive them deterministically without
  // Gemini. The xlsx path defers stub consumption to the chunker
  // (`runChunkedXlsxExtract`) so the chunked-merge test in
  // `aiExtractTimeout.test.ts` can push one stub per chunk and verify
  // the merge order.
  if (
    process.env.NODE_ENV !== "production" &&
    _aiStubQueue.length > 0 &&
    (isImage || isPdf)
  ) {
    const stubbed = _aiStubQueue.shift()!;
    const truncated = _aiStubTruncatedQueue.shift() ?? false;
    return {
      rows: stubbed.map((r) => ({
        ...r,
        driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
      })),
      truncated,
      failedChunks: 0,
    };
  }
  const ai = getGeminiClient();
  const start = Date.now();

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [{ text: buildPrompt(customer, weekStart, weekEnd, roster) }];

  if (isImage) {
    // Caller is expected to have transcoded any HEIC bytes to JPEG already
    // (see `normalizeImageBuffer`), and to pass an image/* mime here.
    const effectiveMime =
      mimeType && /^image\//i.test(mimeType) ? mimeType : "image/jpeg";
    parts.push({
      inlineData: {
        mimeType: effectiveMime,
        data: buffer.toString("base64"),
      },
    });
  } else if (isPdf) {
    const text = await extractTextFromPdf(buffer);
    if (text.trim().length > 50) {
      parts.push({
        text: `\n\n--- PDF TEXT ---\n${text}\n--- END PDF TEXT ---`,
      });
    } else {
      // Scanned PDF (no extractable text). For DeLallo specifically we
      // hand the document to the customer-specialized OCR fallback
      // (`ocrDelalloPDF`) — its prompt knows the exact layout of
      // DeLallo's scanned daily-punches sheets and produces far
      // higher-quality rows than the generic AI extract. The OCR
      // returns fully-resolved ParsedPunch[]; convert back to the
      // AiExtractedRow shape (with `resolvedKfiId` as a hint) so the
      // downstream pipeline in `imageSupport.ts` treats it
      // identically to a normal AI extraction. (Task #277.)
      if (customer.toLowerCase() === "delallo") {
        const year = parseInt(weekStart.slice(0, 4), 10);
        const unmapped = new UnmappedIdAccumulator();
        const punches = await ocrDelalloPDF(buffer, new Set<string>(), year, unmapped);
        // Pass the unresolved (badge-only) rows through the standard
        // downstream resolver — ocrDelalloPDF was called with an
        // empty kfiSet specifically so it returns nothing in
        // `punches` and everything via `unmapped` keyed by badge.
        // That's fine — we instead re-call below with the raw rows.
        // But ocrDelalloPDF doesn't expose raw rows directly, so we
        // simply convert the resolved punches it DID produce (with a
        // real kfiSet would have all rows resolved) into the
        // AiExtractedRow shape. To get every row resolved we run it
        // with a sentinel "accept everything" kfiSet via a Proxy.
        const sentinelKfiSet = new Proxy(new Set<string>(), {
          get(target, prop) {
            if (prop === "has") return () => true;
            return Reflect.get(target, prop);
          },
        });
        const allPunches = await ocrDelalloPDF(
          buffer,
          sentinelKfiSet,
          year,
          new UnmappedIdAccumulator(),
        );
        const rows: AiExtractedRow[] = allPunches.map((p) => ({
          driverNameOnDoc: toDisplayName(p.kfiId),
          badgeOrId: null,
          date: p.date,
          timeIn: p.clockIn.slice(p.date.length).trim() || null,
          timeOut: p.clockOut.slice(p.date.length).trim() || null,
          hours: p.hours,
          resolvedKfiId: p.kfiId,
        }));
        void punches;
        void unmapped;
        logger.info(
          { rows: rows.length, customer },
          "DeLallo scanned-PDF OCR fallback produced rows",
        );
        return { rows, truncated: false, failedChunks: 0 };
      }
      // Generic scanned-PDF path: send the document directly for OCR.
      parts.push({
        inlineData: {
          mimeType: "application/pdf",
          data: buffer.toString("base64"),
        },
      });
    }
  } else {
    // Spreadsheet path: split into one-or-more CSV chunks. Small files
    // produce a single chunk and behave exactly like before; large files
    // get split + each chunk is sent in its own Gemini call below.
    const chunks = xlsxToChunks(buffer, log);
    if (chunks.length > 1) {
      return await runChunkedXlsxExtract(
        ai,
        chunks,
        customer,
        weekStart,
        weekEnd,
        fileName,
        start,
        log,
        roster,
      );
    }
    parts.push({
      text: `\n\n--- SPREADSHEET (CSV) ---\n${chunks[0] ?? ""}\n--- END SPREADSHEET ---`,
    });
  }

  // Per-format ceiling on the Gemini call. Without this an unresponsive
  // upstream leaves the dispatcher staring at a frozen "Uploading…"
  // spinner with no feedback. The race doesn't actually abort the HTTP
  // request (the @google/genai SDK doesn't expose an AbortSignal here)
  // but it does free the request handler so the dispatcher gets an
  // actionable error and can Cancel + retry.
  //
  // Images keep the original 90s budget — they're usually quick and the
  // dispatcher is actively watching a photo upload. xlsx + PDF get a
  // much wider window (5 min) because Task #255's product call is that
  // the FIRST AI extract on a new/drifted customer file must succeed
  // even if it takes a few minutes, so the schema cache learns the
  // column roles and future uploads of the same layout skip AI entirely
  // via the cache → readWithRoles fast path (sub-100ms).
  const AI_TIMEOUT_MS = isImage ? 90_000 : 300_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `AI extraction timed out after ${Math.round(AI_TIMEOUT_MS / 1000)}s — try uploading the original spreadsheet, a smaller/cropped image, or retry in a moment.`,
        ),
      );
    }, AI_TIMEOUT_MS);
  });
  // Test seam (xlsx single-call): consume one stub so unit tests can
  // simulate single-call truncation + recovery without invoking Gemini.
  // Mirrors the image/pdf seam at the top of this function.
  let parsed: { rows?: AiExtractedRow[]; truncated: boolean };
  if (
    process.env.NODE_ENV !== "production" &&
    _aiStubQueue.length > 0 &&
    !isImage &&
    !isPdf
  ) {
    const stubbed = _aiStubQueue.shift()!;
    const truncated = _aiStubTruncatedQueue.shift() ?? false;
    if (timer) clearTimeout(timer);
    parsed = {
      rows: stubbed.map((r) => ({
        ...r,
        driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
      })),
      truncated,
    };
  } else {
    const generate = ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseSchema: ROW_SCHEMA,
        // Weekly customer exports for a 21-driver fleet can easily exceed
        // 8k output tokens (one row per driver per day with five string
        // fields each). Cap generously — the proxy still bills by output
        // tokens used, not requested, so headroom is free.
        maxOutputTokens: 32768,
      },
    });
    let response;
    try {
      response = await Promise.race([generate, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const raw = response.text ?? "";
    parsed = parseOrSalvage(raw, customer, fileName, log);
  }

  // Single-call truncation recovery (Task #264). Gemini hit the 32k
  // output-token cap mid-row. For xlsx we can re-run via forced chunking
  // — the row-count trigger we set above means this almost never happens
  // anymore, but if a freshly-uploaded workbook slips under the 150-row
  // trigger and still truncates (e.g. extremely verbose pay-category
  // splits), the dispatcher shouldn't pay for our threshold miss with a
  // silently-clipped preview. Re-extracts the SAME buffer with a
  // forced-small chunk size and returns the merged rows. PDFs/images
  // don't have a re-chunk path, so we accept partial rows and propagate
  // `truncated: true` so the UI banner fires.
  if (parsed.truncated && !isImage && !isPdf) {
    (log ?? logger).warn(
      { customer, fileName, salvagedRows: parsed.rows?.length ?? 0 },
      "single-call AI response truncated — re-extracting with forced chunking",
    );
    const forcedChunks = xlsxToChunks(buffer, log, { forceChunkMaxRows: 100 });
    return runChunkedXlsxExtract(
      ai,
      forcedChunks,
      customer,
      weekStart,
      weekEnd,
      fileName,
      start,
      log,
      roster,
    );
  }

  const rows = (parsed.rows ?? [])
    .filter(
      (r) => r && typeof r.driverNameOnDoc === "string" && typeof r.date === "string",
    )
    .map((r) => ({
      ...r,
      // Normalize at the ingest boundary so the dispatcher UI, the saved
      // alias, and any downstream comparisons all see the same Title Case
      // form regardless of how the source document cased the name.
      driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
    }));
  const deduped = dedupeAiRows(rows);
  logger.info(
    {
      ms: Date.now() - start,
      aiRawRowCount: rows.length,
      aiDedupedRowCount: deduped.length,
      truncated: parsed.truncated,
      customer,
      fileName,
    },
    "AI extraction complete",
  );
  return { rows: deduped, truncated: parsed.truncated, failedChunks: 0 };
}
