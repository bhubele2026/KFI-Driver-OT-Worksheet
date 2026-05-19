import * as XLSX from "xlsx";
import { Type } from "@google/genai";
import { logger } from "../logger.js";
import { getGeminiClient } from "./gemini.js";
import { toDisplayName } from "./displayName.js";

export interface AiExtractedRow {
  driverNameOnDoc: string;
  badgeOrId?: string | null;
  date: string; // YYYY-MM-DD
  timeIn?: string | null; // "H:MM AM/PM"
  timeOut?: string | null; // "H:MM AM/PM"
  hours?: number | null;
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
        },
        required: ["driverNameOnDoc", "date"],
      },
    },
  },
  required: ["rows"],
};

// Max characters of CSV text we'll ship to Gemini for an xlsx upload.
// Bumped from the original 200k after Task #255: real weekly customer
// exports (Trienda Kronos pivot, ~21 drivers × 7 days × ~5 cols) clear
// 200k once a few text-heavy columns are present, and silent truncation
// was the difference between a successful first-time AI extract (which
// then warms the schema cache for sub-second future uploads) and a
// 0-rows-after-AI dead end. 1 MB is still well under Gemini's input
// token ceiling for `gemini-2.5-flash` and keeps the prompt cost bounded.
const XLSX_CSV_MAX_CHARS = 1_000_000;

// Threshold above which we stop sending the entire workbook in one
// Gemini call and instead split into row-range chunks (Task #255).
// Below this the single-call path is materially cheaper (one round trip,
// one prompt overhead). Above it Gemini reliably hits maxOutputTokens
// mid-row on weekly customer exports, so chunking pays off even with
// the extra round trips. Each chunk re-includes the sheet header so
// Gemini can interpret columns without seeing the whole spreadsheet.
export const XLSX_CHUNK_THRESHOLD_CHARS = 300_000;
// Rough rows-per-chunk target. The chunker measures by chars (so wide
// columns produce smaller chunks than narrow ones) but caps row count
// as a safety net for pathologically wide rows.
const XLSX_CHUNK_MAX_CHARS = 250_000;
const XLSX_CHUNK_MAX_ROWS = 400;

function xlsxToText(buffer: Buffer, log?: SalvageLogger): string {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const out: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    out.push(`# Sheet: ${name}`);
    out.push(XLSX.utils.sheet_to_csv(ws, { blankrows: false }));
  }
  const joined = out.join("\n");
  if (joined.length > XLSX_CSV_MAX_CHARS) {
    log?.warn(
      { rawChars: joined.length, cap: XLSX_CSV_MAX_CHARS },
      "xlsx CSV exceeded prompt cap — truncating before Gemini call",
    );
    return joined.slice(0, XLSX_CSV_MAX_CHARS);
  }
  return joined;
}

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
): string[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  // Total-size shortcut: small workbook → single chunk via the old path
  // (preserves prior prompt shape and keeps the cost identical for the
  // overwhelmingly common case).
  const single = (() => {
    const out: string[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      out.push(`# Sheet: ${name}`);
      out.push(XLSX.utils.sheet_to_csv(ws, { blankrows: false }));
    }
    return out.join("\n");
  })();
  if (single.length <= XLSX_CHUNK_THRESHOLD_CHARS) {
    if (single.length > XLSX_CSV_MAX_CHARS) {
      log?.warn(
        { rawChars: single.length, cap: XLSX_CSV_MAX_CHARS },
        "xlsx CSV exceeded prompt cap — truncating before Gemini call",
      );
      return [single.slice(0, XLSX_CSV_MAX_CHARS)];
    }
    return [single];
  }

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
      while (i < body.length && sliceRows.length < XLSX_CHUNK_MAX_ROWS) {
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

function buildPrompt(customer: string, weekStart: string, weekEnd: string) {
  return [
    `You are extracting timecard punches from a payroll export uploaded for customer "${customer}".`,
    `The week being reconciled is ${weekStart} through ${weekEnd} (Sunday through Saturday). Only return rows whose date falls in that window.`,
    `For each punch row return:`,
    `- driverNameOnDoc: the worker's name as written in the document (preserve casing exactly).`,
    `- badgeOrId: any employee/badge/payroll id shown for that worker (string of digits or alphanum), or omit.`,
    `- date: the punch date as YYYY-MM-DD. Resolve year from the week window if the document only shows MM/DD.`,
    `- timeIn / timeOut: clock in/out as "H:MM AM" or "H:MM PM". Omit if the document only shows total hours.`,
    `- hours: the daily worked hours as a decimal number when shown (e.g. 8.50). Omit if not present.`,
    `Return one row per shift per driver per date. Skip totals, summary, header, footer, and signature lines. Do not invent rows.`,
    `Return strictly JSON matching the provided schema.`,
  ].join("\n");
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
): { rows?: AiExtractedRow[] } {
  try {
    return JSON.parse(raw) as { rows?: AiExtractedRow[] };
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
      return parsed;
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
/** @internal test seam — push rows the next `aiExtractRows` call should return. */
export function __pushAiExtractStub(rows: AiExtractedRow[]): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__pushAiExtractStub is a test seam — not callable in production");
  }
  _aiStubQueue.push(rows);
}
/** @internal test seam — clear any unused stubs (e.g. teardown). */
export function __clearAiExtractStubs(): void {
  _aiStubQueue.length = 0;
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
): Promise<AiExtractedRow[]> {
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
  return (parsed.rows ?? []).filter(
    (r) =>
      r && typeof r.driverNameOnDoc === "string" && typeof r.date === "string",
  );
}

async function runChunkedXlsxExtract(
  ai: ReturnType<typeof getGeminiClient>,
  chunks: string[],
  customer: string,
  weekStart: string,
  weekEnd: string,
  fileName: string,
  startedAt: number,
  log: SalvageLogger | undefined,
): Promise<AiExtractedRow[]> {
  const merged: AiExtractedRow[] = [];
  // Test seam: if `__pushAiExtractStub` has been used, consume one stub
  // per chunk so unit tests can drive the chunked path deterministically.
  for (let i = 0; i < chunks.length; i++) {
    if (
      process.env.NODE_ENV !== "production" &&
      _aiStubQueue.length > 0
    ) {
      const stubbed = _aiStubQueue.shift()!;
      for (const r of stubbed) {
        merged.push({ ...r, driverNameOnDoc: toDisplayName(r.driverNameOnDoc) });
      }
      continue;
    }
    const prompt =
      buildPrompt(customer, weekStart, weekEnd) +
      `\n\nThis is chunk ${i + 1} of ${chunks.length} of the same workbook. Return only the rows in this chunk.\n\n--- SPREADSHEET (CSV) ---\n${chunks[i]}\n--- END SPREADSHEET ---`;
    const rows = await callGeminiForChunk(ai, prompt, customer, fileName, log);
    for (const r of rows) {
      merged.push({ ...r, driverNameOnDoc: toDisplayName(r.driverNameOnDoc) });
    }
  }
  logger.info(
    {
      ms: Date.now() - startedAt,
      rows: merged.length,
      chunks: chunks.length,
      customer,
      fileName,
    },
    "AI extraction complete (chunked)",
  );
  return merged;
}

export async function aiExtractRows(
  fileName: string,
  buffer: Buffer,
  customer: string,
  weekStart: string,
  weekEnd: string,
  mimeType?: string,
  log?: SalvageLogger,
): Promise<AiExtractedRow[]> {
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
    return stubbed.map((r) => ({
      ...r,
      driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
    }));
  }
  const ai = getGeminiClient();
  const start = Date.now();

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [{ text: buildPrompt(customer, weekStart, weekEnd) }];

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
      // Scanned PDF: send the document directly for OCR.
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
      const merged = await runChunkedXlsxExtract(
        ai,
        chunks,
        customer,
        weekStart,
        weekEnd,
        fileName,
        start,
        log,
      );
      return merged;
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
  const parsed = parseOrSalvage(raw, customer, fileName, log);

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
  logger.info(
    { ms: Date.now() - start, rows: rows.length, customer, fileName },
    "AI extraction complete",
  );
  return rows;
}
