import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { logger } from "../logger.js";
import { toDisplayName } from "./displayName.js";
import { ocrDelalloPDF } from "./ocr.js";
import { UnmappedIdAccumulator } from "./types.js";
import {
  estimatePromptTokens,
  getFallbackModelClient,
  getModelClient,
  getTokenPacer,
  isRetryableModelError,
  runWithConcurrency,
  withModelRetry,
  type ContentPart,
  type ModelCallUsage,
  type ModelClient,
} from "./modelClient.js";
import {
  IngestionBudget,
  IngestionBudgetExceeded,
  type IngestionBudgetSummary,
  type IngestionPurpose,
} from "./ingestionBudget.js";

/**
 * Per-upload options bag for `aiExtractRows`. All fields optional; the
 * upload route in `weeks.ts` builds this from the customers row + the
 * dispatcher's request flags (Task #297).
 */
export interface AiExtractOptions {
  /**
   * Pre-built budget tracker. When omitted, `aiExtractRows` constructs
   * a fresh one and discards it on return — fine for direct unit tests
   * but loses the spend summary, so production code paths should always
   * pass one in and inspect `budget.summary()` post-call.
   */
  budget?: IngestionBudget;
  /**
   * When true, a non-retryable primary-provider failure may fall back
   * to the secondary provider (Claude → Gemini or vice versa). Defaults
   * to FALSE — the auto-fallback that motivated Task #297 (a single
   * upload spent ~$3 because Claude failures multiplied the spend on
   * Gemini) is now opt-in per customer.
   */
  allowGeminiFallback?: boolean;
  /**
   * Task #296: fired after every chunk completes in the chunked xlsx
   * path so the upload route can publish "chunk N of M" to the
   * frontend's polling progress endpoint. Single-call / image / PDF
   * paths emit one final `(1, 1)` tick so the dispatcher always sees
   * a completion event. Never throws — observer-only.
   */
  onChunkProgress?: (current: number, total: number) => void;
  /**
   * Task #314: opaque per-upload id minted at the route boundary and
   * stamped onto every event this upload pushes into the process-wide
   * `TokenPacer`. The route handler MUST call
   * `releaseIngestion(ingestionId)` in `finally` so the bucket evicts
   * this upload's events the instant extraction resolves — without
   * eviction the natural 60s rolling window leaves "ghost load"
   * stalling the next upload. When omitted, `aiExtractRows` mints a
   * throwaway uuid (still tagged so backstop eviction works, but
   * cleanup is left to the 60s window).
   */
  ingestionId?: string;
}

/** Result shape returned by `aiExtractRows`, extended with budget telemetry (Task #297). */
export interface AiExtractResult {
  rows: AiExtractedRow[];
  /**
   * Per-upload spend summary. Always present; counts may all be zero
   * when a test stub short-circuited every model call.
   */
  budgetSummary: IngestionBudgetSummary;
  /** True when at least one chunk's primary call failed and Gemini fallback served it. */
  geminiFallbackUsed: boolean;
}

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
 * (collected from `driver_id_aliases`), and any
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
// chunk's JSON output well under the 32k output-token cap AND each
// chunk's wall-clock under the per-chunk 120s ceiling. Task #279
// dropped from 100 to 60 after Penda (522 rows ÷ 100 = 6 chunks @
// concurrency=4 = ~2 waves * 90s ≈ 3+ min) routinely blew the
// dispatcher's patience budget; at 60 rows/chunk Penda becomes 9
// chunks of ~25-35s each and the bumped concurrency (6) finishes
// them in ~2 waves of <40s each — well under 60s total.
const XLSX_CHUNK_MAX_CHARS = 180_000;
// Task #296: bumped 60 -> 120 alongside Claude prompt caching. With the
// shared prefix (rules + roster + schema example) cached at
// `cache_control: ephemeral`, the per-chunk cost is dominated by the
// CSV body itself; doubling rows-per-chunk halves the chunk count
// (Adient: 71 -> ~35) so a tier-1 first-time upload completes in 2
// waves instead of thrashing against the 30k input-tokens/min cap.
const XLSX_CHUNK_MAX_ROWS = 120;
// Task #307: per-chunk row cap for block-structured xlsx layouts (a
// header band that repeats once per driver, e.g. Adient). Halved vs
// the flat-layout cap so Claude — which writes one JSON row per
// SOURCE line in a block-structured CSV — doesn't truncate
// mid-block on the 32k-output-tokens cap. Flat customers (Penda,
// TriEnda) are unaffected: they continue at 120 rows/chunk.
export const XLSX_CHUNK_MAX_ROWS_BLOCK = 60;

/**
 * Task #307: detect a "block-structured" xlsx layout — one where a
 * short header / marker band repeats once per driver group, like
 * Adient's per-employee bands ("Job,,,,J0000…", "Transaction Apply
 * Date,…"). Flat customer exports (Penda: 18-column single-header
 * CSV with one row per punch) never repeat a full row verbatim, so a
 * repeated identical non-empty CSV line is a reliable signal.
 *
 * Heuristic: returns true when ANY non-trivial trimmed CSV line
 * appears 3+ times in a sheet. Lines over 400 chars are skipped
 * (real header bands are short label rows, not long data rows; this
 * also keeps the cost bounded on multi-MB inputs).
 *
 * Cheap, defensive, and safe: any XLSX parse failure returns false
 * (caller treats the file as flat — same as today).
 */
export function detectXlsxBlockStructure(buffer: Buffer): boolean {
  try {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      const lines = csv.split("\n");
      const counts = new Map<string, number>();
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        // All-commas / blank-ish lines aren't meaningful repeats.
        if (!t.replace(/,/g, "").trim()) continue;
        // Long lines are body rows, not header bands.
        if (t.length > 400) continue;
        const n = (counts.get(t) ?? 0) + 1;
        if (n >= 3) return true;
        counts.set(t, n);
      }
    }
  } catch {
    // Parse failures (corrupt workbook, OOM, etc.) — fall back to
    // flat-layout behaviour. The chunker will throw its own error
    // downstream if the file is genuinely unreadable.
  }
  return false;
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
  opts?: { forceChunkMaxRows?: number; maxRowsPerChunk?: number },
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

  const maxRowsPerChunk = forced ?? opts?.maxRowsPerChunk ?? XLSX_CHUNK_MAX_ROWS;
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

export function buildPrompt(
  customer: string,
  weekStart: string,
  weekEnd: string,
  roster?: RosterContext,
  provider?: string,
) {
  // Claude gets a tailored prompt: concrete domain role, an inline
  // NDJSON example with a worked sample line, and an explicit
  // "no markdown fences, no prose, no array wrapper" instruction placed
  // right next to the example (Task #293 follow-up + Task #308 NDJSON
  // cut-over). Gemini keeps its shorter prompt — both providers now
  // emit NDJSON line-by-line; we no longer rely on Gemini's
  // `responseSchema` (which requires a single top-level JSON value
  // and is incompatible with newline-delimited output).
  if (provider === "claude") {
    return buildClaudePrompt(customer, weekStart, weekEnd, roster);
  }
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
    ``,
    `## Output format (NDJSON, Task #308)`,
    `Return one JSON object per line — newline-delimited JSON. No surrounding array. No outer "{ rows: [...] }" wrapper. No prose. No \`\`\` fences. Each line is a complete JSON object on its own line.`,
    `Each line MUST be a single JSON object with the per-row fields above (driverNameOnDoc, badgeOrId, date, timeIn, timeOut, hours, resolvedKfiId).`,
    `If the document body marks rows with a leading row-id token of the form "[R<n>]" (chunked spreadsheet path), copy that number into a "_row" field on the output line. For a tagged input row you decide to skip (header / footer / subtotal / blank with no driver), emit \`{"_row":N,"_skip":true}\` so the caller can tell you saw it. Do NOT skip silently.`,
    `Example (NDJSON, one JSON object per line):`,
    `{"_row":1,"driverNameOnDoc":"JOHN SMITH","date":"${weekStart}","timeIn":"6:00 AM","timeOut":"2:30 PM","hours":8.5,"resolvedKfiId":"smithjo01"}`,
    `{"_row":2,"_skip":true}`,
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
 * Claude-tailored prompt. Anthropic's API doesn't enforce a response
 * schema the way Gemini does — Claude follows the prompt — so we
 * (a) state the role concretely in payroll-domain terms,
 * (b) put the JSON schema example LAST so it's the freshest context
 *     before the document, mirroring Anthropic's own prompt-engineering
 *     recommendation, and
 * (c) call out "raw JSON, no ```json fences, no prose" explicitly twice
 *     — once in the rules block and once right next to the schema —
 *     because Claude Sonnet's default chat habit is to fence structured
 *     output and that's what produced the first live-fire failure.
 */
function buildClaudePrompt(
  customer: string,
  weekStart: string,
  weekEnd: string,
  roster?: RosterContext,
): string {
  const lines: string[] = [
    `You are a payroll-data extractor for a logistics dispatcher reconciling driver hours against customer-supplied timecards. Accuracy matters more than coverage — misrouted or invented punches cause real payroll errors that a human has to chase down on Monday morning.`,
    ``,
    `## What you are doing`,
    `Extract every timecard punch row from the document below for customer "${customer}".`,
    `The payroll week being reconciled is ${weekStart} through ${weekEnd} (Sunday through Saturday, inclusive). Drop any row whose date falls outside that window.`,
    ``,
    `## Field definitions`,
    `- driverNameOnDoc (required, string): the worker's name as written in the document. Preserve casing exactly — do not Title-Case "JOHN SMITH" to "John Smith".`,
    `- badgeOrId (string, omit if absent): any employee number / badge / payroll id printed next to the name (digits, alphanumeric, or both). Strip leading zeros only if the document itself shows them stripped elsewhere.`,
    `- date (required, "YYYY-MM-DD"): the punch date. If the document only prints MM/DD, fill in the year from the payroll-week window above. Never invent a date that isn't anchored in the document.`,
    `- timeIn / timeOut (string "H:MM AM" or "H:MM PM", omit if absent): clock in and clock out. Omit BOTH (not just one) if the document only reports a daily total.`,
    `- hours (number, omit if absent): daily worked hours as a decimal, e.g. 8.5 or 10.25. Omit if the document gives you clock times instead of a total.`,
    `- resolvedKfiId (string, OMIT WHEN IN DOUBT): only set this when the row's worker is unambiguously one of the KNOWN DRIVERS listed below — exact badge match, exact alias match (case-insensitive), or names that are clearly the same person (e.g. "J. Smith" → "John Smith" when no other "Smith" is in the list). Setting the wrong id silently misroutes payroll. When unsure, leave it out and the dispatcher will pick the driver.`,
    ``,
    `## Rules`,
    `1. Emit ONE output row for EVERY non-empty data row in the document. Do not merge, sum, or combine rows for the same driver/date — even when pay-category columns (e.g. "Reg", "OT 1.5", "SHIFT PREM", "PREM-NIGHT", "VAC", "HOL") split one shift across several lines, copy each line as its own output row. We deduplicate downstream; your job is faithful row-by-row transcription.`,
    `2. The ONLY lines to skip are: column headers, completely blank rows, page footers / signature blocks, and grand-total / subtotal rows that have no driver name. When in doubt, include the row.`,
    `3. Do not invent rows, drivers, dates, or times that aren't in the document. A partial extract is fine; fabrication is not.`,
    `4. Output NDJSON only — one JSON object per line. No surrounding array. No outer "{ rows: [...] }" wrapper. No \`\`\`json fences. No prose before or after. No "Here is the extracted data:" preamble. Start the first line with \`{\` and end the last line with \`}\`. A trailing newline is fine.`,
  ];

  if (roster && roster.drivers.length > 0) {
    lines.push("");
    lines.push(`## KNOWN DRIVERS for customer "${roster.customer}"`);
    lines.push(
      `Use resolvedKfiId to point a row at one of these ONLY when you're confident. Format: "<kfiId>: <name>; badges=[…]; aliases=[…]".`,
    );
    const cap = 200;
    for (const d of roster.drivers.slice(0, cap)) {
      const parts: string[] = [`${d.kfiId}: ${d.name}`];
      if (d.badges.length > 0) parts.push(`badges=[${d.badges.join(", ")}]`);
      if (d.aliases.length > 0) parts.push(`aliases=[${d.aliases.join(", ")}]`);
      lines.push(`- ${parts.join("; ")}`);
    }
    if (roster.drivers.length > cap) {
      lines.push(`- (${roster.drivers.length - cap} more drivers omitted from this prompt)`);
    }
  }

  lines.push("");
  lines.push("## Output format (NDJSON, Task #308)");
  lines.push(
    "Return ONE JSON object per line — newline-delimited JSON (NDJSON). No surrounding `[...]` array. No outer `{ \"rows\": [...] }` wrapper. No prose. No ```json fences. Each line is a complete JSON object on its own line; an extra trailing newline at the very end is fine.",
  );
  lines.push("Example (each line below is exactly one output line):");
  lines.push("```");
  lines.push(
    `{"_row":1,"driverNameOnDoc":"JOHN SMITH","badgeOrId":"10472","date":"${weekStart}","timeIn":"6:00 AM","timeOut":"2:30 PM","hours":8.5,"resolvedKfiId":"smithjo01"}`,
  );
  lines.push(`{"_row":2,"_skip":true}`);
  lines.push("```");
  lines.push(
    `Reminder: send the JSON lines directly, without the surrounding triple-backtick fence shown above (the fence is for illustration only). Required keys per data row are driverNameOnDoc and date; all other keys are optional and should be omitted (not set to null) when the document doesn't show them.`,
  );
  lines.push(
    `If the document body tags rows with a leading "[R<n>]" identifier (chunked spreadsheet path), echo that number as the "_row" field on EVERY output line — data lines AND skip lines. For any tagged input row you decide to skip (header / footer / subtotal / blank with no driver), emit \`{"_row":N,"_skip":true}\` so we can tell the row was seen and intentionally dropped instead of silently lost.`,
  );
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

/** Minimal logger shape — accepts req.log (pino child) or the module logger. */
type SalvageLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * Parse the model's NDJSON response into rows + emitted `_row` IDs (Task #308).
 *
 * Each non-blank line is independently `JSON.parse`'d. Lines that fail
 * to parse are dropped silently — the chunked-path caller compares
 * emitted vs expected `_row` IDs to detect missing rows and re-issues
 * them in a targeted retry. A trailing partial line (the classic
 * maxOutputTokens cut-off) just shows up as one missing `_row` and is
 * handled by the same re-issue mechanism — there is no separate
 * "truncated" flag.
 *
 * Lines with `_skip: true` are intentional drops by the model (headers,
 * subtotals, etc.); their `_row` ID is still counted as "emitted" so we
 * don't re-issue them. Lines without the required `driverNameOnDoc` /
 * `date` keys are dropped (but their `_row` is recorded). Stray ```
 * fences from a misbehaving model are tolerated at the start/end.
 */
export interface ParsedNdjson {
  rows: AiExtractedRow[];
  /** `_row` IDs emitted by the model (data + skip lines), used to detect missing rows. */
  emittedRowIds: Set<number>;
  /** Count of non-blank input lines (for the lines-emitted-vs-expected telemetry). */
  nonBlankLines: number;
  /** Count of non-blank input lines that failed to JSON.parse. */
  parseFailedLines: number;
}

function isLikelyFenceMarker(line: string): boolean {
  const t = line.trim();
  return t.startsWith("```") || t === "" || t === "[" || t === "]";
}

export function parseNdjson(raw: string): ParsedNdjson {
  const rows: AiExtractedRow[] = [];
  const emittedRowIds = new Set<number>();
  let nonBlankLines = 0;
  let parseFailedLines = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Tolerate stray ``` fence markers / bare brackets a model might
    // sneak in despite the prompt — they're not data, just noise.
    if (isLikelyFenceMarker(line)) continue;
    // A trailing comma or `,` between objects is occasionally observed
    // when a model mentally renders an array — strip a single trailing
    // comma before parsing.
    const cleaned = line.endsWith(",") ? line.slice(0, -1) : line;
    nonBlankLines++;
    let obj: unknown;
    try {
      obj = JSON.parse(cleaned);
    } catch {
      parseFailedLines++;
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    if (typeof o._row === "number" && Number.isFinite(o._row)) {
      emittedRowIds.add(o._row);
    }
    if (o._skip === true) continue;
    if (typeof o.driverNameOnDoc !== "string" || typeof o.date !== "string") {
      continue;
    }
    // Drop the internal `_row` field before handing the row downstream;
    // the rest of the pipeline doesn't know about it.
    const { _row: _r, _skip: _s, ...rest } = o;
    void _r;
    void _s;
    rows.push(rest as unknown as AiExtractedRow);
  }
  return { rows, emittedRowIds, nonBlankLines, parseFailedLines };
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
interface AiStub {
  rows: AiExtractedRow[];
  /**
   * Task #308: when set, the chunked-path test seam pretends the model
   * "forgot" these `_row` IDs so the targeted re-issue branch runs.
   * Undefined = stub claims to have emitted every assigned row.
   */
  missingRowIds?: Set<number>;
}
const _aiStubQueue: AiStub[] = [];
// Parallel queue of per-stub errors. When the head is a non-null Error,
// the next stub consumer throws it instead of returning rows — lets the
// Task #267 partial-failure test simulate "one chunk's Gemini call blew
// up" without actually invoking Gemini.
const _aiStubErrorQueue: (Error | null)[] = [];
/**
 * @internal test seam — push rows the next `aiExtractRows` call should return.
 *
 * `opts.missingRowIds` (Task #308) lets a chunked-path test simulate
 * "model dropped some assigned `_row` IDs" so the targeted re-issue
 * mechanism is exercised. When omitted (the common case), the stub
 * pretends every assigned row was emitted and no re-issue runs.
 */
export function __pushAiExtractStub(
  rows: AiExtractedRow[],
  opts?: { missingRowIds?: number[] },
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__pushAiExtractStub is a test seam — not callable in production");
  }
  _aiStubQueue.push({
    rows,
    missingRowIds: opts?.missingRowIds
      ? new Set(opts.missingRowIds)
      : undefined,
  });
  _aiStubErrorQueue.push(null);
}
/** @internal test seam — push an error the next chunk consumer should throw. */
export function __pushAiExtractErrorStub(message: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__pushAiExtractErrorStub is a test seam — not callable in production");
  }
  _aiStubQueue.push({ rows: [] });
  _aiStubErrorQueue.push(new Error(message));
}
/** @internal test seam — clear any unused stubs (e.g. teardown). */
export function __clearAiExtractStubs(): void {
  _aiStubQueue.length = 0;
  _aiStubErrorQueue.length = 0;
}

// Per-chunk model-call ceiling for the chunked xlsx path. Shorter than
// the single-call 5-minute budget because each chunk is small; we still
// cap total wall-clock by stopping early if any chunk exceeds this.
const XLSX_CHUNK_TIMEOUT_MS = 120_000;

/**
 * Per-call structured log entry. Emitted at info-level for every real
 * provider round-trip so we can correlate spend on the `ingest_done`
 * summary with individual chunks (Task #297). Keep the field shape
 * stable — the admin debugging playbook greps for these.
 */
function logModelCall(opts: {
  log: SalvageLogger | undefined;
  chunkLabel: string;
  purpose: IngestionPurpose;
  usage: ModelCallUsage;
  elapsedMs: number;
  customer: string;
  fileName: string;
}): void {
  const target = (opts.log ?? logger) as SalvageLogger & {
    info?: (obj: Record<string, unknown>, msg: string) => void;
  };
  const fields = {
    customer: opts.customer,
    fileName: opts.fileName,
    chunkLabel: opts.chunkLabel,
    purpose: opts.purpose,
    provider: opts.usage.provider,
    model: opts.usage.model,
    inputTokens: opts.usage.inputTokens,
    outputTokens: opts.usage.outputTokens,
    elapsedMs: opts.elapsedMs,
  };
  const msg = "AI model call complete";
  if (typeof target.info === "function") {
    target.info(fields, msg);
  } else {
    target.warn(fields, msg);
  }
}

/**
 * Per-chunk model call with retry-on-transient-failure and quiet
 * fallback to the secondary provider. The retry policy (3 attempts,
 * jittered exp backoff 1.5s → 8s on 429 / 503 / 5xx / network) was
 * added in Task #293 alongside the Claude swap; with Gemini still
 * wired as a quiet fallback the dispatcher's first-of-its-kind
 * upload reliably completes even during provider hiccups.
 */
async function callModelForChunk(
  client: ModelClient,
  buildParts: (c: ModelClient) => ContentPart[],
  customer: string,
  fileName: string,
  log: SalvageLogger | undefined,
  label: string,
  budget: IngestionBudget,
  allowGeminiFallback: boolean,
  ingestionId: string,
): Promise<{
  rows: AiExtractedRow[];
  emittedRowIds: Set<number>;
  nonBlankLines: number;
}> {
  // `buildParts(c)` is called per-attempt so the prompt is re-tailored
  // to whichever provider actually handles the request — important on
  // the Claude→Gemini (or reverse) fallback path, where the two
  // providers want subtly different prompt shapes (see `buildPrompt`).
  // The withModelRetry attempt counter is exposed so we can distinguish
  // a chunk's first call (`purpose: 'chunk'`) from its automatic retries
  // (`purpose: 'chunk_retry'`) in the per-upload spend breakdown.
  const callOnce = async (
    c: ModelClient,
    isFallback: boolean,
  ): Promise<{ text: string }> => {
    let attempt = 0;
    return withModelRetry(
      async () => {
        attempt++;
        const startedAt = Date.now();
        // Task #296: pace dispatch against the provider's per-minute
        // input-tokens window BEFORE making the HTTP call. The Claude
        // pacer is sized at 25k/60s (5k headroom below tier-1's 30k
        // ceiling); Gemini's pacer is a no-op. With prompt caching the
        // estimate over-counts cached chunks but that's fine — a brief
        // extra pause is far cheaper than a 429 retry-after sleep.
        const parts = buildParts(c);
        const estTokens = estimatePromptTokens(parts);
        const pacer = getTokenPacer(c.name);
        const waited = await pacer.acquire(estTokens, ingestionId);
        budget.addPacerWait(waited);
        // Task #314: one structured info line per dispatch so the log
        // answers "is the pacer throttling me?" without extra forensics.
        const pacerState = pacer.state(ingestionId);
        const dispatchLogTarget = (log ?? logger) as SalvageLogger & {
          info?: (obj: Record<string, unknown>, msg: string) => void;
        };
        const dispatchFields = {
          customer,
          fileName,
          chunkLabel: label,
          provider: c.name,
          estTokens,
          pacerWaitMs: waited,
          pacerState,
        };
        if (typeof dispatchLogTarget.info === "function") {
          dispatchLogTarget.info(dispatchFields, "AI chunk dispatch");
        } else {
          dispatchLogTarget.warn(dispatchFields, "AI chunk dispatch");
        }
        const result = await c.generate({
          parts,
          maxOutputTokens: 32768,
          timeoutMs: XLSX_CHUNK_TIMEOUT_MS,
        });
        const purpose: IngestionPurpose = isFallback
          ? "gemini_fallback"
          : attempt > 1
          ? "chunk_retry"
          : label.includes("re-issue")
          ? "chunk_reissue"
          : "chunk";
        logModelCall({
          log,
          chunkLabel: label,
          purpose,
          usage: result.usage,
          elapsedMs: Date.now() - startedAt,
          customer,
          fileName,
        });
        budget.recordCall(result.usage, purpose);
        return { text: result.text };
      },
      { label: `${c.name}:${label}`, log },
    );
  };
  let raw: string;
  try {
    raw = (await callOnce(client, false)).text;
  } catch (err) {
    // After all retries exhausted, optionally try the other provider once as a
    // safety net so a single bad minute on Anthropic doesn't sink the upload.
    // OPT-IN per customer post-Task #297: the auto-fallback used to silently
    // multiply spend by routing failures into a second provider; now the
    // dispatcher (or the customers-table flag) explicitly authorizes it.
    if (err instanceof IngestionBudgetExceeded) throw err;
    const fb =
      allowGeminiFallback && isRetryableModelError(err)
        ? await getFallbackModelClient(client)
        : null;
    if (!fb) throw err;
    (log ?? logger).warn(
      {
        primary: client.name,
        fallback: fb.name,
        chunk: label,
        customer,
        fileName,
        errMsg: err instanceof Error ? err.message : String(err),
      },
      "AI primary provider failed after retries — falling back to secondary",
    );
    raw = (await callOnce(fb, true)).text;
  }
  const parsed = parseNdjson(raw);
  return {
    rows: parsed.rows,
    emittedRowIds: parsed.emittedRowIds,
    nonBlankLines: parsed.nonBlankLines,
  };
}

// How many chunks to run in parallel. Task #296 dropped from 6 -> 3
// after a 71-chunk Adient first-time upload thrashed the Anthropic
// tier-1 ceiling (30k input tokens/min). With prompt caching cutting
// the per-chunk new-input tokens to roughly just the CSV body
// (~3-6k tokens/chunk) AND the bigger chunk size halving the chunk
// count, 3 concurrent chunks * ~5k input tokens = ~15k/min sustained
// — leaves room for the cache_creation tokens on chunk 1 + the
// retry-after-honoring pacer to absorb estimation slips without
// busting the limit. The Task #293 retry/backoff at the model-client
// layer is still the defense-in-depth for transient 429s on the
// tail.
const XLSX_CHUNK_CONCURRENCY = 3;

/**
 * Build the chunk body text shown to the model, tagging each body row
 * with a `[R<n>] ` prefix (Task #308). The model is asked in the prompt
 * to echo that number as `_row` on every output line — data lines and
 * `_skip` lines alike — so we can diff emitted vs assigned IDs and
 * surgically re-issue any that got lost.
 */
function buildTaggedChunkText(
  marker: string,
  header: string,
  body: string[],
  ids: number[],
): string {
  const taggedBody = ids
    .map((id, i) => `[R${id}] ${body[i]}`)
    .join("\n");
  return [marker, header, taggedBody].join("\n");
}

async function runChunkedXlsxExtract(
  client: ModelClient,
  chunks: string[],
  customer: string,
  weekStart: string,
  weekEnd: string,
  fileName: string,
  startedAt: number,
  log: SalvageLogger | undefined,
  budget: IngestionBudget,
  allowGeminiFallback: boolean,
  ingestionId: string,
  roster?: RosterContext,
  onChunkProgress?: (current: number, total: number) => void,
): Promise<{ rows: AiExtractedRow[] }> {
  // Task #296: emit (0, total) before the first chunk so the polling
  // client sees a definitive total as soon as work begins, then
  // (completed, total) after each chunk finishes. Never lets observer
  // throws bubble.
  let completedChunks = 0;
  const tickProgress = () => {
    completedChunks++;
    try {
      onChunkProgress?.(completedChunks, chunks.length);
    } catch {
      /* observer-only */
    }
  };
  try {
    onChunkProgress?.(0, chunks.length);
  } catch {
    /* observer-only */
  }
  /**
   * Run one model call against a tagged sub-chunk (Task #308). Returns
   * the rows the model produced PLUS the set of `_row` IDs it emitted
   * (data + skip lines) so the caller can detect missing IDs and
   * decide whether to re-issue. Honors the test stub queue.
   */
  const runOne = async (
    marker: string,
    header: string,
    body: string[],
    ids: number[],
    label: string,
  ): Promise<{
    rows: AiExtractedRow[];
    emittedRowIds: Set<number>;
    nonBlankLines: number;
  }> => {
    // Test seam: if `__pushAiExtractStub` has been used, consume one stub
    // per request so unit tests can drive the chunked path deterministically.
    if (
      process.env.NODE_ENV !== "production" &&
      _aiStubQueue.length > 0
    ) {
      const stubbed = _aiStubQueue.shift()!;
      const err = _aiStubErrorQueue.shift() ?? null;
      if (err) throw err;
      // Default: stub claims to have emitted every assigned `_row` ID
      // (no re-issue triggered). When `missingRowIds` is set, omit
      // those from `emittedRowIds` so the caller's diff identifies
      // them as missing and the re-issue branch fires.
      const emitted = new Set<number>();
      for (const id of ids) {
        if (!stubbed.missingRowIds || !stubbed.missingRowIds.has(id)) {
          emitted.add(id);
        }
      }
      return {
        rows: stubbed.rows.map((r) => ({
          ...r,
          driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
        })),
        emittedRowIds: emitted,
        nonBlankLines: emitted.size,
      };
    }
    // Task #296: split the chunked-extract prompt into two text parts so
    // Claude can cache the (identical-across-chunks) prefix. The prefix
    // — rules, roster, schema example — is byte-identical for every
    // chunk of one upload, so marking it `cacheable: true` makes chunk
    // 1 pay `cache_creation` tokens once and chunks 2..N read from the
    // ephemeral cache at ~10% the price AND outside the per-minute
    // input-tokens window. Gemini ignores the flag.
    const taggedChunk = buildTaggedChunkText(marker, header, body, ids);
    const buildParts = (c: ModelClient): ContentPart[] => [
      {
        kind: "text",
        text: buildPrompt(customer, weekStart, weekEnd, roster, c.name),
        cacheable: true,
      },
      {
        kind: "text",
        text: `\n\n${label} of the same workbook. Each body line is prefixed with a "[R<n>]" tag — copy that number into the "_row" field on every output NDJSON line (data and \`_skip\` lines alike). Return only the rows in this chunk.\n\n--- SPREADSHEET (CSV) ---\n${taggedChunk}\n--- END SPREADSHEET ---`,
      },
    ];
    // Defensive assertion: the chunker is supposed to cap each chunk at
    // ~180k chars / 60 rows. If we're about to ship a payload wildly
    // larger than the assigned row count would justify (>500 chars per
    // row), bail BEFORE burning a model call. The bug that motivated
    // this (Task #297) was a malformed chunk that ballooned to 10×
    // its intended payload size and ate the entire token budget across
    // retries before failing.
    const assignedRowCount = Math.max(1, ids.length);
    const promptChars = buildParts(client).reduce(
      (n, p) => n + (p.kind === "text" ? p.text.length : 0),
      0,
    );
    // The cacheable prefix (rules + roster + NDJSON example) is a flat
    // ~4-5k chars regardless of body size, so a re-issue carrying only
    // 1-2 rows looks "huge" by per-row ratio. Apply a floor that covers
    // the prefix; the guard still trips on real prompt-bloat (e.g. a
    // 200k chunk of body for 10 rows).
    if (promptChars > Math.max(assignedRowCount * 500, 8000)) {
      (log ?? logger).warn(
        {
          customer,
          fileName,
          label,
          promptChars,
          assignedRowCount,
          ratio: Math.round(promptChars / assignedRowCount),
        },
        "AI chunk payload exceeds safety ratio (chars-per-row > 500) — refusing to send",
      );
      throw new Error(
        `AI extraction stopped: chunk "${label}" prompt is ${promptChars} chars for only ${assignedRowCount} rows. The chunker produced a malformed split — re-upload after splitting the spreadsheet by hand.`,
      );
    }
    const out = await callModelForChunk(
      client,
      buildParts,
      customer,
      fileName,
      log,
      label,
      budget,
      allowGeminiFallback,
      ingestionId,
    );
    return {
      rows: out.rows.map((r) => ({
        ...r,
        driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
      })),
      emittedRowIds: out.emittedRowIds,
      nonBlankLines: out.nonBlankLines,
    };
  };

  // Cooperative cancellation: the first chunk to throw flips this
  // flag so the worker pool stops dequeuing new indices AND in-flight
  // chunks short-circuit their (expensive) re-issue retries instead of
  // racing more model calls after the upload is already doomed.
  let aborted = false;
  const handleChunkInner = async (
    idx: number,
  ): Promise<{ rows: AiExtractedRow[] }> => {
    if (aborted) return { rows: [] };
    // Parse the chunk into marker / header / body once so the
    // re-issue branch can address individual body rows by ID.
    const allLines = chunks[idx].split("\n");
    const marker = allLines[0] ?? "";
    const header = allLines[1] ?? "";
    const body = allLines.slice(2);
    const assignedIds = body.map((_, i) => i + 1);
    const expected = assignedIds.length;
    const label = `This is chunk ${idx + 1} of ${chunks.length}`;
    const result = await runOne(marker, header, body, assignedIds, label);
    if (aborted) return { rows: [] };
    // Telemetry (Task #308): per-chunk lines-emitted vs lines-expected
    // so we can see at a glance how often the model is dropping rows.
    (log ?? logger).warn(
      {
        customer,
        fileName,
        chunk: idx + 1,
        chunkCount: chunks.length,
        expected,
        emitted: result.emittedRowIds.size,
        nonBlankLines: result.nonBlankLines,
        rows: result.rows.length,
      },
      "AI chunk NDJSON lines emitted vs expected",
    );
    const missing = assignedIds.filter((id) => !result.emittedRowIds.has(id));
    if (missing.length === 0) {
      return { rows: result.rows };
    }
    // One targeted re-issue: re-send ONLY the body lines whose `_row`
    // IDs never came back, preserving their original IDs in the
    // [R<n>] tags so the dispatcher's downstream view still mirrors
    // the source order. If the second call ALSO misses any IDs, we
    // fail loud — silent partial extraction is exactly what Task #308
    // is trying to eliminate.
    (log ?? logger).warn(
      {
        customer,
        fileName,
        chunk: idx + 1,
        chunkCount: chunks.length,
        missingCount: missing.length,
        missingSample: missing.slice(0, 10),
      },
      "AI chunk missing row IDs — re-issuing targeted retry",
    );
    const missingBody = missing.map((id) => body[id - 1]);
    const reissueLabel = `This is chunk ${idx + 1} of ${chunks.length} (re-issue of ${missing.length} missing rows)`;
    const reissue = await runOne(marker, header, missingBody, missing, reissueLabel);
    if (aborted) return { rows: [] };
    const stillMissing = missing.filter((id) => !reissue.emittedRowIds.has(id));
    if (stillMissing.length > 0) {
      aborted = true;
      throw new Error(
        `AI could not extract the full file — chunk ${idx + 1} of ${chunks.length} is missing ${stillMissing.length} rows after one re-issue retry. Split the spreadsheet into two smaller files and re-upload.`,
      );
    }
    return { rows: [...result.rows, ...reissue.rows] };
  };

  // Wrap so ANY throw from handleChunkInner (timeout, network error,
  // schema validation failure, etc.) trips the abort flag — not just
  // the explicit throws inside handleChunkInner. Without this, an
  // early runOne() timeout on chunk 1 of 10 would let chunks 2-10
  // finish their Gemini calls before Promise.all's rejection bubbled.
  const handleChunk = async (
    idx: number,
  ): Promise<{ rows: AiExtractedRow[] }> => {
    try {
      const out = await handleChunkInner(idx);
      tickProgress();
      return out;
    } catch (err) {
      aborted = true;
      throw err;
    }
  };

  // Bounded-concurrency worker pool. Preserves document order in the
  // results array (so the merged output mirrors the chunk order, which
  // matters for the schema-cache recorder downstream).
  const results = new Array<{ rows: AiExtractedRow[] }>(chunks.length);
  let nextIdx = 0;
  const workerCount = Math.min(XLSX_CHUNK_CONCURRENCY, chunks.length);
  // Task #279: any chunk that throws aborts the upload. We do NOT
  // continue with surviving chunks any more — silent loss is worse
  // than a clear error the dispatcher can act on.
  const workers = Array.from({ length: workerCount }, async () => {
    while (!aborted) {
      const idx = nextIdx++;
      if (idx >= chunks.length) break;
      results[idx] = await handleChunk(idx);
    }
  });
  await Promise.all(workers);

  const merged: AiExtractedRow[] = [];
  for (const r of results) {
    for (const row of r.rows) merged.push(row);
  }
  const deduped = dedupeAiRows(merged);
  logger.info(
    {
      ms: Date.now() - startedAt,
      aiRawRowCount: merged.length,
      aiDedupedRowCount: deduped.length,
      chunks: chunks.length,
      concurrency: workerCount,
      customer,
      fileName,
    },
    "AI extraction complete (chunked)",
  );
  return { rows: deduped };
}

/**
 * Emit the per-upload `ingest_done` summary log. Centralized so both
 * the success path and the catch path in `aiExtractRows` write a
 * consistently-shaped line — the admin debugging playbook greps for
 * `"ingest_done"` to pull every upload's spend across the API log.
 */
function logIngestDone(
  log: SalvageLogger | undefined,
  fields: {
    customer: string;
    fileName: string;
    outcome: "success" | "budget_exceeded" | "extraction_failed";
    wallTimeMs: number;
    rowCount: number;
    summary: IngestionBudgetSummary;
    errMsg?: string;
  },
): void {
  const target = (log ?? logger) as SalvageLogger & {
    info?: (obj: Record<string, unknown>, msg: string) => void;
  };
  const payload = {
    customer: fields.customer,
    fileName: fields.fileName,
    outcome: fields.outcome,
    wallTimeMs: fields.wallTimeMs,
    rowCount: fields.rowCount,
    totalCalls: fields.summary.totalCalls,
    totalInputTokens: fields.summary.totalInputTokens,
    totalOutputTokens: fields.summary.totalOutputTokens,
    totalTokens: fields.summary.totalTokens,
    totalCostUsd: fields.summary.totalCostUsd,
    byPurpose: fields.summary.byPurpose,
    byProvider: fields.summary.byProvider,
    geminiFallbackUsed: fields.summary.geminiFallbackUsed,
    warnedHot: fields.summary.warnedHot,
    blockStructured: fields.summary.blockStructured,
    rowsPerChunk: fields.summary.rowsPerChunk,
    ...(fields.errMsg ? { errMsg: fields.errMsg } : {}),
  };
  const msg = "ingest_done";
  if (typeof target.info === "function") {
    target.info(payload, msg);
  } else {
    target.warn(payload, msg);
  }
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
  opts?: AiExtractOptions,
): Promise<AiExtractResult> {
  const budget =
    opts?.budget ?? new IngestionBudget({ fileName, customer, log });
  const allowGeminiFallback = opts?.allowGeminiFallback ?? false;
  // Task #314: when the caller didn't mint an id, fabricate one so
  // every pacer event still carries some tag (the 60s window then
  // acts as the eviction backstop). Production callers always pass
  // one through so the route's `finally` can release cleanly.
  const ingestionId = opts?.ingestionId ?? randomUUID();
  return aiExtractRowsImpl(
    fileName,
    buffer,
    customer,
    weekStart,
    weekEnd,
    mimeType,
    log,
    roster,
    budget,
    allowGeminiFallback,
    ingestionId,
    opts?.onChunkProgress,
  );
}

async function aiExtractRowsImpl(
  fileName: string,
  buffer: Buffer,
  customer: string,
  weekStart: string,
  weekEnd: string,
  mimeType: string | undefined,
  log: SalvageLogger | undefined,
  roster: RosterContext | undefined,
  budget: IngestionBudget,
  allowGeminiFallback: boolean,
  ingestionId: string,
  onChunkProgress?: (current: number, total: number) => void,
): Promise<AiExtractResult> {
  const overallStart = Date.now();
  // Wrap the rest of the function in try/catch so a budget trip or any
  // other thrown error still emits an `ingest_done` summary log before
  // re-throwing. The route handler is responsible for persisting the
  // matching `ingestion_runs` row.
  try {
    const result = await runExtraction(
      fileName,
      buffer,
      customer,
      weekStart,
      weekEnd,
      mimeType,
      log,
      roster,
      budget,
      allowGeminiFallback,
      ingestionId,
      onChunkProgress,
    );
    const summary = budget.summary();
    logIngestDone(log, {
      customer,
      fileName,
      outcome: "success",
      wallTimeMs: Date.now() - overallStart,
      rowCount: result.rows.length,
      summary,
    });
    return {
      ...result,
      budgetSummary: summary,
      geminiFallbackUsed: summary.geminiFallbackUsed,
    };
  } catch (err) {
    const summary = budget.summary();
    const outcome: "budget_exceeded" | "extraction_failed" =
      err instanceof IngestionBudgetExceeded
        ? "budget_exceeded"
        : "extraction_failed";
    logIngestDone(log, {
      customer,
      fileName,
      outcome,
      wallTimeMs: Date.now() - overallStart,
      rowCount: 0,
      summary,
      errMsg: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function runExtraction(
  fileName: string,
  buffer: Buffer,
  customer: string,
  weekStart: string,
  weekEnd: string,
  mimeType: string | undefined,
  log: SalvageLogger | undefined,
  roster: RosterContext | undefined,
  budget: IngestionBudget,
  allowGeminiFallback: boolean,
  ingestionId: string,
  onChunkProgress?: (current: number, total: number) => void,
): Promise<{ rows: AiExtractedRow[] }> {
  // Task #296: never let an observer throw bubble out and tank the
  // extract. Single-call / image / PDF paths emit a single final
  // (1, 1) so the polling client always sees a completion event.
  const safeProgress = (current: number, total: number) => {
    try {
      onChunkProgress?.(current, total);
    } catch {
      /* observer-only */
    }
  };
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isImage =
    (mimeType && /^image\//i.test(mimeType)) ||
    /\.(jpg|jpeg|png|webp)$/i.test(lower);
  // Test stub seam: image + pdf paths consume a single stub here so
  // `imageSupport.test.ts` can drive them deterministically without
  // a real model call. The xlsx path defers stub consumption to the
  // chunker (`runChunkedXlsxExtract`).
  if (
    process.env.NODE_ENV !== "production" &&
    _aiStubQueue.length > 0 &&
    (isImage || isPdf)
  ) {
    const stubbed = _aiStubQueue.shift()!;
    return {
      rows: stubbed.rows.map((r) => ({
        ...r,
        driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
      })),
    };
  }
  const client = await getModelClient();
  const start = Date.now();

  // Provider-independent attachments (binary blobs, CSV-as-text, PDF text).
  // The leading prompt text is rebuilt per-client at call time so the
  // Claude→Gemini fallback path doesn't reuse the wrong-shaped prompt.
  const attachmentParts: ContentPart[] = [];
  const buildParts = (c: ModelClient): ContentPart[] => [
    { kind: "text", text: buildPrompt(customer, weekStart, weekEnd, roster, c.name) },
    ...attachmentParts,
  ];

  if (isImage) {
    // Caller is expected to have transcoded any HEIC bytes to JPEG already
    // (see `normalizeImageBuffer`), and to pass an image/* mime here.
    const effectiveMime =
      mimeType && /^image\//i.test(mimeType) ? mimeType : "image/jpeg";
    attachmentParts.push({
      kind: "inlineData",
      mimeType: effectiveMime,
      data: buffer.toString("base64"),
    });
  } else if (isPdf) {
    const text = await extractTextFromPdf(buffer);
    if (text.trim().length > 50) {
      attachmentParts.push({
        kind: "text",
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
        const punches = await ocrDelalloPDF(buffer, new Set<string>(), year, unmapped, {}, budget);
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
          {},
          budget,
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
        return { rows };
      }
      // Generic scanned-PDF path: send the document directly for OCR.
      attachmentParts.push({
        kind: "inlineData",
        mimeType: "application/pdf",
        data: buffer.toString("base64"),
      });
    }
  } else {
    // Spreadsheet path: split into one-or-more CSV chunks. Small files
    // produce a single chunk and behave exactly like before; large files
    // get split + each chunk is sent in its own model call below.
    //
    // Task #307: detect "block-structured" layouts (Adient-class: a
    // header band that repeats once per driver) and halve the
    // per-chunk row cap from 120 to 60. Flat customers (Penda) keep
    // the 120-row budget. Recorded on the budget so the
    // `ingest_done` log + `ingestion_runs` row carry the decision
    // through to the admin audit view.
    const blockStructured = detectXlsxBlockStructure(buffer);
    const rowsPerChunk = blockStructured
      ? XLSX_CHUNK_MAX_ROWS_BLOCK
      : XLSX_CHUNK_MAX_ROWS;
    budget.recordXlsxLayout({ blockStructured, rowsPerChunk });
    const chunks = xlsxToChunks(buffer, log, { maxRowsPerChunk: rowsPerChunk });
    if (chunks.length > 1) {
      return await runChunkedXlsxExtract(
        client,
        chunks,
        customer,
        weekStart,
        weekEnd,
        fileName,
        start,
        log,
        budget,
        allowGeminiFallback,
        ingestionId,
        roster,
        onChunkProgress,
      );
    }
    attachmentParts.push({
      kind: "text",
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
  // Test seam (xlsx single-call): consume one stub so unit tests can
  // drive the single-call path deterministically. Mirrors the image/pdf
  // seam at the top of this function.
  let parsed: ParsedNdjson;
  if (
    process.env.NODE_ENV !== "production" &&
    _aiStubQueue.length > 0 &&
    !isImage &&
    !isPdf
  ) {
    const stubbed = _aiStubQueue.shift()!;
    parsed = {
      rows: stubbed.rows.map((r) => ({
        ...r,
        driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
      })),
      emittedRowIds: new Set<number>(),
      nonBlankLines: stubbed.rows.length,
      parseFailedLines: 0,
    };
  } else {
    // Weekly customer exports for a 21-driver fleet can easily exceed
    // 8k output tokens (one row per driver per day with five string
    // fields each). Cap generously — providers bill by output tokens
    // used, not requested, so headroom is free.
    const callOnce = (c: ModelClient, isFallback: boolean) => {
      let attempt = 0;
      return withModelRetry(
        async () => {
          attempt++;
          const callStart = Date.now();
          // Task #314: pace the single-call path with the same tagged
          // pacer used by chunked uploads so concurrent single-call
          // and chunked uploads share the global TPM budget honestly,
          // and so the `finally` release in the route handler evicts
          // events from both paths.
          const parts = buildParts(c);
          const estTokens = estimatePromptTokens(parts);
          const pacer = getTokenPacer(c.name);
          const waited = await pacer.acquire(estTokens, ingestionId);
          budget.addPacerWait(waited);
          const pacerState = pacer.state(ingestionId);
          const dispatchLogTarget = (log ?? logger) as SalvageLogger & {
            info?: (obj: Record<string, unknown>, msg: string) => void;
          };
          const dispatchFields = {
            customer,
            fileName,
            chunkLabel: "single-call",
            provider: c.name,
            estTokens,
            pacerWaitMs: waited,
            pacerState,
          };
          if (typeof dispatchLogTarget.info === "function") {
            dispatchLogTarget.info(dispatchFields, "AI chunk dispatch");
          } else {
            dispatchLogTarget.warn(dispatchFields, "AI chunk dispatch");
          }
          const result = await c.generate({
            parts,
            maxOutputTokens: 32768,
            timeoutMs: AI_TIMEOUT_MS,
          });
          const purpose: IngestionPurpose = isFallback
            ? "gemini_fallback"
            : attempt > 1
            ? "chunk_retry"
            : "chunk";
          logModelCall({
            log,
            chunkLabel: "single-call",
            purpose,
            usage: result.usage,
            elapsedMs: Date.now() - callStart,
            customer,
            fileName,
          });
          budget.recordCall(result.usage, purpose);
          return { text: result.text };
        },
        { label: `${c.name}:single-call`, log },
      );
    };
    let raw: string;
    try {
      raw = (await callOnce(client, false)).text;
    } catch (err) {
      // Quiet fallback to the secondary provider once retries exhaust on
      // a clearly-transient failure (Task #293). Opt-in per customer
      // post-Task #297 so a primary-provider outage doesn't silently
      // double the upload's spend.
      if (err instanceof IngestionBudgetExceeded) throw err;
      const fb =
        allowGeminiFallback && isRetryableModelError(err)
          ? await getFallbackModelClient(client)
          : null;
      if (!fb) throw err;
      (log ?? logger).warn(
        {
          primary: client.name,
          fallback: fb.name,
          customer,
          fileName,
          errMsg: err instanceof Error ? err.message : String(err),
        },
        "AI primary provider failed after retries — falling back to secondary",
      );
      raw = (await callOnce(fb, true)).text;
    }
    parsed = parseNdjson(raw);
  }

  // Single-call path completed — emit a final (1, 1) so the polling
  // client sees a definitive completion event.
  safeProgress(1, 1);

  const rows = parsed.rows
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
      nonBlankLines: parsed.nonBlankLines,
      parseFailedLines: parsed.parseFailedLines,
      customer,
      fileName,
    },
    "AI extraction complete",
  );
  return { rows: deduped };
}
