import * as XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import * as schema from "@workspace/db/schema";
import {
  computeHeaderSignature,
  extractPdfLinesByPage,
} from "./schemaSignature.js";
import type { ParseResult, ParsedPunch } from "./types.js";

/**
 * Locate the xlsx column indices that carried the badge / date /
 * timeIn / timeOut / hours values of the AI's first emitted punch.
 *
 * Approach: parse the workbook, for each row see whether it contains
 * the punch's normalized badge AND date string. The matching row's
 * cells reveal which columns hold each field. Returns null if no
 * confident match — caller skips persisting (better to re-run AI next
 * time than cache wrong roles).
 */
export function inferColumnRoles(
  buffer: Buffer,
  sample: {
    rawBadge: string;
    dateIso: string;
    clockIn: string;
    clockOut: string;
    /**
     * Driver name as the AI saw it on the source row (Task #338). When
     * present, the recorder also locates the column whose cell on the
     * same row matches it (case-insensitive trimmed equality) and stores
     * the index as `name`. When absent or no match is found, `name` is
     * left `null` — older cached recipes don't carry it and the reader
     * tolerates that.
     */
    name?: string | null;
    /**
     * Worked hours the AI read for the sample row. When present, the recorder
     * locates the column whose numeric cell on the same row equals it and
     * stores the index as `hours`, so the deterministic cache reader can HONOR
     * the customer's own Total/Hours/Duration column (break + rounding baked
     * in) instead of recomputing from clock in/out. Null when not found.
     */
    hours?: number | null;
  },
): {
  badge: number;
  date: number;
  timeIn: number;
  timeOut: number;
  hours?: number | null;
  name?: number | null;
} | null {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    return null;
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
  });
  const badgeNeedle = sample.rawBadge.trim().toLowerCase();
  const dateNeedle = sample.dateIso;
  const timeInNeedle = sample.clockIn.split(" ").slice(1).join(" "); // "H:MM AM"
  const timeOutNeedle = sample.clockOut.split(" ").slice(1).join(" ");
  const nameNeedle =
    typeof sample.name === "string" && sample.name.trim().length > 0
      ? sample.name.trim().toLowerCase()
      : null;
  const hoursNeedle =
    typeof sample.hours === "number" && sample.hours > 0 ? sample.hours : null;

  // xlsx (cellDates:true) hands us JS Date objects for cells that
  // Excel stores as dates/datetimes. These cells have a meaningful
  // time component when the source column actually holds a clock
  // value (e.g. Penda's "Time Start Raw" / "Time End Raw"). Match
  // those by formatting the Date in UTC as "h:mm AM/PM" — Excel
  // does not encode a tz, and xlsx normalizes to UTC, so this is
  // the value that lines up with the AI-extracted wall clock.
  const formatTimeUtc = (d: Date): string => {
    const h24 = d.getUTCHours();
    const m = d.getUTCMinutes();
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 || 12;
    return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
  };

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    let badgeCol = -1;
    let dateCol = -1;
    let timeInCol = -1;
    let timeOutCol = -1;
    let nameCol = -1;
    let hoursCol = -1;
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (v == null) continue;
      // Hours column: a numeric cell equal to the AI's stated hours for this
      // row (small tolerance for 2-dp rounding). Skip Date cells.
      if (
        hoursCol < 0 &&
        hoursNeedle != null &&
        !(v instanceof Date) &&
        Number.isFinite(Number(v)) &&
        Math.abs(Number(v) - hoursNeedle) < 0.02
      ) {
        hoursCol = i;
        continue;
      }
      const s =
        v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
      // For time matching, use the wall-clock representation of a
      // Date cell; for non-Date cells, the cell's own string form
      // (e.g. "5:40 AM", "05:40").
      const sTime = v instanceof Date ? formatTimeUtc(v) : s;
      // A Date cell carries a meaningful time component if its
      // wall-clock isn't midnight; in that case prefer time-matching
      // over date-matching so a "Time Start Raw" / "Time End Raw"
      // style column (date + time on one Date cell) is recognized as
      // a time column rather than swallowed by the date check.
      const dateHasTime =
        v instanceof Date &&
        (v.getUTCHours() !== 0 || v.getUTCMinutes() !== 0);
      if (
        badgeCol < 0 &&
        s.toLowerCase() === badgeNeedle
      ) {
        badgeCol = i;
        continue;
      }
      if (
        nameCol < 0 &&
        nameNeedle &&
        s.toLowerCase() === nameNeedle
      ) {
        nameCol = i;
        continue;
      }
      if (
        timeInCol < 0 &&
        timeInNeedle &&
        sTime.toUpperCase().includes(timeInNeedle.toUpperCase())
      ) {
        timeInCol = i;
        continue;
      }
      if (
        timeOutCol < 0 &&
        timeOutNeedle &&
        timeOutNeedle !== timeInNeedle &&
        sTime.toUpperCase().includes(timeOutNeedle.toUpperCase())
      ) {
        timeOutCol = i;
        continue;
      }
      if (dateCol < 0 && !dateHasTime) {
        if (v instanceof Date) {
          if (v.toISOString().slice(0, 10) === dateNeedle) {
            dateCol = i;
            continue;
          }
        } else if (s.includes(dateNeedle.slice(5))) {
          // tolerate M/D variants
          dateCol = i;
          continue;
        }
      }
    }
    if (
      badgeCol >= 0 &&
      dateCol >= 0 &&
      timeInCol >= 0 &&
      timeOutCol >= 0
    ) {
      return {
        badge: badgeCol,
        date: dateCol,
        timeIn: timeInCol,
        timeOut: timeOutCol,
        // Record the name column whenever we found one on the same
        // row — null when the file genuinely has no name column or
        // the caller didn't pass a needle (Task #338). Older cached
        // recipes simply won't carry this and `readWithRoles` will
        // fall back to the "(no name on doc)" placeholder.
        name: nameCol >= 0 ? nameCol : null,
        // Record the customer's Total/Hours column so cached re-uploads
        // honor it (readWithRoles:272 already prefers columnRoles.hours).
        hours: hoursCol >= 0 ? hoursCol : null,
      };
    }
  }
  return null;
}

/* ============================================================
 * PDF role inference (Task #257)
 *
 * Given an AI ParseResult and the original PDF bytes, derive two
 * regex templates so the next upload with the same layout can be
 * read deterministically by `readPdfWithRoles` instead of going
 * back to Gemini:
 *
 *   - `employeeAnchor` — recognizes a "new employee starts here"
 *     line and captures the raw badge id in group 1.
 *   - `dataRow` — recognizes a per-punch line and captures the
 *     in-time and out-time strings (group 1, group 2), with
 *     optional hours in group 3.
 *
 * Inference walks every line of the PDF, finds the line that
 * carries the AI's first punch's badge to build the employee
 * anchor, and finds the line that carries that punch's two clock
 * times to build the data-row template. The templates are built
 * by escaping the matched line, then swapping in capture groups
 * exactly where the badge / time values appeared. This keeps the
 * surrounding literal context (label words like "ID:", "Badge #:",
 * `(`/`)`, "Employee:") so we don't accidentally match unrelated
 * lines on subsequent uploads.
 *
 * Returns null if either template can't be confidently built —
 * caller skips persisting and the next upload re-runs AI.
 * ============================================================ */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find a line that contains `badge` as a contiguous token (i.e. NOT
 * embedded inside another alphanumeric run), and build a regex that
 * keeps the immediate literal context (1-3 chars on either side
 * trimmed to non-alphanumeric delimiters) but replaces the badge
 * itself with `([A-Za-z0-9]+)`.
 *
 * Examples (badge "TELD9001"):
 *   "BAILEY, R. (TELD9001)" → /\(([A-Za-z0-9]+)\)/
 *   "Employee: Doe ID: TELD9001" → /ID:\s*([A-Za-z0-9]+)/
 *   "Name: Doe Badge #: TELD9001" → /Badge\s*#:\s*([A-Za-z0-9]+)/
 *
 * When `name` is provided (Task #341) and the same line also carries
 * that driver name, the generated regex additionally captures the
 * name as a named group `(?<name>...)` alongside the badge as
 * `(?<badge>...)`. `readPdfWithRoles` surfaces that name in the
 * unmapped panel on cached re-uploads (PDF analog of the Task #338
 * xlsx fix). If the name can't be located on the badge's line, falls
 * back to the badge-only regex with badge as group 1.
 */
export function buildEmployeeAnchorRegex(
  lines: string[],
  badge: string,
  name?: string | null,
): string | null {
  if (!badge) return null;
  const esc = escapeRegex(badge);
  // Word-boundary-ish: badge surrounded by start/end or non-alphanumeric.
  const badgeRe = new RegExp(`(^|[^A-Za-z0-9])(${esc})($|[^A-Za-z0-9])`);
  const nameTrim = typeof name === "string" ? name.trim() : "";
  for (const line of lines) {
    const m = badgeRe.exec(line);
    if (!m) continue;
    const idx = m.index + m[1].length;
    const left = line.slice(0, idx);

    // Preferred branch (Task #341): name on the same line as badge.
    // Build a named-capture regex so the reader sees both, regardless
    // of which appears first textually (e.g. "BAILEY, R. (TELD9001)"
    // vs "Employee: Doe ID: TELD9001"). The name capture is a
    // restrictive non-greedy class that stops at the first delimiter
    // or paren — enough to grab "BAILEY, R." but not so loose that
    // it eats across columns.
    if (nameTrim) {
      const idxName = left.toLowerCase().indexOf(nameTrim.toLowerCase());
      if (idxName >= 0) {
        const preName = left.slice(0, idxName);
        const between = left.slice(idxName + nameTrim.length);
        const right = line.slice(idx + badge.length);
        const suffixMatch = right.match(/^\s*([)\].,;:])/);
        const suffix = suffixMatch ? suffixMatch[1] : "";
        let regex = "";
        if (preName.trim()) regex += escapeFlex(preName);
        // Non-greedy class avoiding parens/brackets so we stop at the
        // "(" before the badge in the "BAILEY, R. (TELD9001)" shape.
        regex += "(?<name>[^()\\[\\]{}|<>\\t\\n]+?)";
        regex += escapeFlex(between || " ");
        regex += "(?<badge>[A-Za-z0-9]+)";
        if (suffix) regex += "\\s*" + escapeRegex(suffix);
        return regex;
      }
    }
    // Walk back from the badge to find a stable delimiter anchor:
    // an optional label word (e.g. "ID", "Badge", "EmpID") followed
    // by a punctuation delimiter (`:`, `#`, `(`, `[`) that introduces
    // the badge. Skip trailing whitespace. This deliberately ignores
    // any prior-employee NAME content on the same line because names
    // vary per row.
    const anchorMatch = left.match(
      /([A-Za-z]+(?:\s*[A-Za-z]+)?)?\s*([#:(\[][\s#:]*)\s*$/,
    );
    if (!anchorMatch) continue;
    const label = (anchorMatch[1] ?? "").trim();
    const delim = anchorMatch[2].replace(/\s+/g, "");
    // Walk right to capture an optional closing delimiter.
    const right = line.slice(idx + badge.length);
    const suffixMatch = right.match(/^\s*([)\].,;:])/);
    const suffix = suffixMatch ? suffixMatch[1] : "";
    // Build the regex piecewise. \s* between segments tolerates
    // re-encoded PDFs with different whitespace runs.
    let regex = "";
    if (label) regex += escapeRegex(label) + "\\s*";
    regex += escapeRegex(delim) + "\\s*";
    regex += "([A-Za-z0-9]+)";
    if (suffix) regex += "\\s*" + escapeRegex(suffix);
    return regex;
  }
  return null;
}

/**
 * Find a line that contains BOTH the punch's in-time and out-time
 * substrings (e.g. "6:00 AM" and "2:30 PM"), and build a regex that
 * captures both as `(\d{1,2}:\d{2}\s*[AP]M)` while keeping the
 * surrounding context literal. Optionally captures a trailing hours
 * value as group 3 when one appears within ~30 chars to the right of
 * the out-time.
 */
export function buildDataRowRegex(
  lines: string[],
  clockIn: string,
  clockOut: string,
  hours: number | null,
): string | null {
  // clockIn / clockOut are "YYYY-MM-DD H:MM AM/PM" — pull just the time.
  const inTime = clockIn.split(" ").slice(1).join(" ").trim();
  const outTime = clockOut.split(" ").slice(1).join(" ").trim();
  if (!inTime || !outTime) return null;

  // Flexible time-substring regex (handles "6:00 AM", "06:00AM", "6:00 am").
  const flexibleTimeRe = (t: string) => {
    const tm = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!tm) return null;
    const h = parseInt(tm[1]);
    const min = tm[2];
    const tag = tm[3];
    return new RegExp(
      `0?${h}:${min}\\s*${tag[0]}\\.?\\s*${tag[1]}\\.?`,
      "i",
    );
  };
  const inRe = flexibleTimeRe(inTime);
  const outRe = flexibleTimeRe(outTime);
  if (!inRe || !outRe) return null;

  for (const line of lines) {
    const inMatch = inRe.exec(line);
    const outMatch = outRe.exec(line);
    if (!inMatch || !outMatch) continue;
    // Require in-time to appear before out-time on the line (otherwise
    // the times aren't a punch pair).
    if (inMatch.index >= outMatch.index) continue;

    const before = line.slice(0, inMatch.index);
    const between = line.slice(inMatch.index + inMatch[0].length, outMatch.index);
    const afterOut = line.slice(outMatch.index + outMatch[0].length);

    // Optional hours capture: a "\d+\.\d{1,2}" within 30 chars of the
    // out-time, that matches the AI's reported hours value (tolerates
    // small rounding). Otherwise reader falls back to diffHours.
    let hoursCapture = "";
    let afterSuffix = afterOut;
    if (hours != null && hours > 0) {
      const tail = afterOut.slice(0, 30);
      const hoursStr = hours.toFixed(2);
      const altStr = hours.toString();
      const hPos = tail.indexOf(hoursStr) !== -1
        ? tail.indexOf(hoursStr)
        : tail.indexOf(altStr);
      const hLen = tail.indexOf(hoursStr) !== -1 ? hoursStr.length : altStr.length;
      if (hPos >= 0) {
        const pre = tail.slice(0, hPos);
        afterSuffix = tail.slice(hPos + hLen) + afterOut.slice(30);
        hoursCapture =
          escapeFlex(pre) + "(\\d+(?:\\.\\d{1,2})?)";
      }
    }

    // Build regex. Use \s* generosity between literal segments so PDFs
    // with re-encoded spacing still match. Anchor with surrounding
    // literal context (trimmed to 20 chars each side) — but allow
    // anything before/after by anchoring on `.*` only if absolutely
    // needed. We keep the regex unanchored (no ^/$) so a longer line
    // with extra columns still matches.
    const beforeKeep = before.slice(Math.max(0, before.length - 40));
    const afterKeep = afterSuffix.slice(0, 20);
    const TIME_GRP = "(\\d{1,2}:\\d{2}\\s*[AP]M)";
    const regex =
      escapeFlexWithDates(beforeKeep) +
      TIME_GRP +
      escapeFlexWithDates(between) +
      TIME_GRP +
      hoursCapture +
      (afterKeep && !hoursCapture
        ? escapeFlexWithDates(afterKeep.slice(0, 5))
        : "");
    return regex;
  }
  return null;
}

// Date substrings inside the literal-context portions of the data-row
// regex must not be hard-coded — date values change every week. Replace
// each detected date with `.+?` (lazy, so it doesn't eat the captured
// time groups) and escapeFlex the surrounding literals.
const DATE_LIKE_RE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(?:,\s*\d{4})?|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi;
function escapeFlexWithDates(s: string): string {
  if (!s) return "";
  const parts: string[] = [];
  let last = 0;
  for (const m of s.matchAll(DATE_LIKE_RE)) {
    parts.push(escapeFlex(s.slice(last, m.index)));
    parts.push(".+?");
    last = m.index + m[0].length;
  }
  parts.push(escapeFlex(s.slice(last)));
  return parts.join("");
}

// Escape a literal chunk, replacing whitespace runs with `\s*` and
// keeping alphanumerics/punctuation as escaped literals. This is what
// makes the generated regex tolerant of varied spacing across PDFs.
function escapeFlex(s: string): string {
  if (!s) return "";
  // Tokenize by whitespace runs.
  const parts = s.split(/(\s+)/);
  return parts
    .map((p) => (p.length === 0 ? "" : /^\s+$/.test(p) ? "\\s*" : escapeRegex(p)))
    .join("");
}

/**
 * Infer PDF column roles from a successful AI extraction. See module
 * header for the protocol. Returns null when either the employee
 * anchor or the data-row regex can't be confidently inferred — caller
 * skips writing the cache row in that case.
 */
export async function inferPdfColumnRoles(
  buffer: Buffer,
  sample: {
    rawBadge: string;
    clockIn: string;
    clockOut: string;
    hours: number;
    /**
     * Driver name the AI saw alongside the badge on the source PDF
     * (Task #341). When present and locatable on the same anchor line
     * as the badge, the inferred employeeAnchor regex captures it as
     * a named group so cached re-uploads can surface the name in the
     * unmapped panel. Optional — when omitted or not found, the regex
     * falls back to badge-only (legacy shape).
     */
    name?: string | null;
  },
  fallbackYear: number,
): Promise<{
  format: "pdf";
  employeeAnchor: { regex: string };
  dataRow: { regex: string };
  fallbackYear: number;
} | null> {
  const pages = await extractPdfLinesByPage(buffer);
  if (!pages) return null;
  const flat = pages.flat();
  const empRegex = buildEmployeeAnchorRegex(flat, sample.rawBadge, sample.name);
  if (!empRegex) return null;
  const dataRegex = buildDataRowRegex(
    flat,
    sample.clockIn,
    sample.clockOut,
    sample.hours,
  );
  if (!dataRegex) return null;
  return {
    format: "pdf",
    employeeAnchor: { regex: empRegex },
    dataRow: { regex: dataRegex },
    fallbackYear,
  };
}

/**
 * Pure decision step for {@link recordAiSchemaIfPossible}: given the
 * AI result + the original buffer, return what should happen to the
 * `customer_column_schemas` row keyed on `(customer, signature,
 * format)`. Three outcomes:
 *
 *   - `upsert`: roles were confidently inferred — write/overwrite the
 *     cached fast-path entry.
 *   - `delete-stale` (Task #258): AI succeeded but new roles couldn't
 *     be inferred from the same buffer. The existing cache row, if
 *     any, is stale (it returned 0 rows for this upload), so wipe it
 *     so the next upload re-runs AI directly instead of paying the
 *     "cache → 0 → AI" tax forever.
 *   - `skip`: nothing actionable (no signature, no format, image
 *     upload, empty AI result).
 *
 * Exposed for hermetic testing. No DB / no network.
 */
export type SchemaCacheMutation =
  | {
      action: "upsert";
      format: "xlsx" | "pdf";
      signature: string;
      columnRoles: Record<string, unknown>;
    }
  | { action: "delete-stale"; format: "xlsx" | "pdf"; signature: string }
  | { action: "skip"; reason: string };

export async function deriveSchemaCacheMutation(args: {
  customer: string;
  fileName: string;
  buffer: Buffer;
  aiResult: ParseResult;
  weekStart: string;
}): Promise<SchemaCacheMutation> {
  const { fileName, buffer, aiResult, weekStart } = args;
  const signature = await computeHeaderSignature(fileName, buffer);
  if (!signature) return { action: "skip", reason: "no-signature" };
  const first = aiResult.punches[0];
  if (!first) return { action: "skip", reason: "no-ai-rows" };
  const lower = fileName.toLowerCase();
  const format: "xlsx" | "pdf" | null =
    lower.endsWith(".xlsx") || lower.endsWith(".xls")
      ? "xlsx"
      : lower.endsWith(".pdf")
        ? "pdf"
        : null;
  if (!format) return { action: "skip", reason: "unsupported-format" };

  // Try several emitted punches before giving up on role inference.
  // The AI occasionally lightly rounds / reformats clock values on its
  // first emitted row in a way that doesn't perfectly line up against
  // any single workbook cell (e.g. dropping a leading zero or shifting
  // a minute). Other rows in the same response usually do line up,
  // and a single matching row is enough to pin the column layout for
  // the whole sheet — so a delete-stale outcome from a one-off
  // first-row mismatch costs the next upload another full AI run for
  // no real reason.
  let roles: unknown = null;
  const candidates = aiResult.punches.slice(0, 8);
  for (const candidate of candidates) {
    const rawBadge = pickRawBadge(candidate);
    if (!rawBadge) continue;
    if (format === "xlsx") {
      roles = inferColumnRoles(buffer, {
        rawBadge,
        dateIso: candidate.date,
        clockIn: candidate.clockIn,
        clockOut: candidate.clockOut,
        // Task #338: pass the AI's driver name so the recorder can
        // also pin down the name column. Optional — when the AI run
        // didn't carry one through, role inference still succeeds
        // and `name` is recorded as null.
        name: candidate.nameOnDoc ?? null,
        // Pass the AI's hours so the recorder pins the customer's own
        // Total/Hours column for deterministic re-uploads.
        hours: typeof candidate.hours === "number" ? candidate.hours : null,
      });
    } else {
      const fallbackYear = parseInt(weekStart.slice(0, 4));
      roles = await inferPdfColumnRoles(
        buffer,
        {
          rawBadge,
          clockIn: candidate.clockIn,
          clockOut: candidate.clockOut,
          hours: candidate.hours,
          // Task #341: pass the AI's driver name so the recorder can
          // also pin the name down on the employee-anchor line and
          // cache it via a named capture group. Optional — falls back
          // to badge-only when the AI didn't carry a name through.
          name: candidate.nameOnDoc ?? null,
        },
        fallbackYear,
      );
    }
    if (roles) break;
  }
  if (!roles) {
    // AI succeeded but we couldn't infer roles from this buffer. Any
    // existing cache row under the same (customer, signature, format)
    // is by definition stale — it just produced 0 rows for the same
    // file. Wipe it so the next upload doesn't pay the "cache → 0 →
    // AI" tax indefinitely.
    return { action: "delete-stale", format, signature };
  }
  return {
    action: "upsert",
    format,
    signature,
    columnRoles: roles as Record<string, unknown>,
  };
}

/**
 * After a successful AI extraction on a customer-file upload, derive
 * column roles for the file's layout and upsert a
 * `customer_column_schemas` row keyed on `(customer, signature,
 * format)`. On subsequent uploads with the same header / layout
 * signature the route's `lookupSchema → 'cache'` branch consumes
 * these roles via `readWithRoles` (xlsx) or `readPdfWithRoles` (pdf),
 * skipping AI entirely.
 *
 * No-op for image uploads (no stable signature), when no signature
 * can be computed, when AI returned 0 punches, or for unsupported
 * file formats. When AI succeeded but roles can't be inferred from
 * this buffer (Task #258), any stale `(customer, signature, format)`
 * row is deleted so the next upload re-runs AI directly instead of
 * burning time on the stale cache → 0 → AI fallback every week.
 * Designed to never throw — failure here only costs the next upload
 * another AI call.
 *
 * Returns `true` only when fresh roles were written; `false` for both
 * skip and delete-stale outcomes (the response's `cacheWritten` chip
 * means "next upload will be instant", which isn't true after a
 * delete).
 */
export async function recordAiSchemaIfPossible(args: {
  customer: string;
  fileName: string;
  buffer: Buffer;
  aiResult: ParseResult;
  weekStart: string;
  log: {
    warn: (obj: object, msg: string) => void;
    info: (obj: object, msg: string) => void;
  };
}): Promise<boolean> {
  const { customer, fileName, log } = args;
  // Task #441: emit one `schema_cache_write` line per upload regardless
  // of outcome so we can tell from logs whether the AI run produced an
  // upsert, deleted a stale row, or skipped entirely (and why). The
  // signature_prefix correlates with the matching schema_lookup line
  // earlier in the same request.
  const logWrite = async (
    action: "upsert" | "delete-stale" | "skip",
    extra: {
      format?: "xlsx" | "pdf";
      signature?: string;
      reason?: string;
    },
  ) => {
    log.info(
      {
        customer,
        format: extra.format ?? null,
        signature_prefix: extra.signature ? extra.signature.slice(0, 8) : null,
        action,
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
      "schema_cache_write",
    );
  };
  try {
    const mutation = await deriveSchemaCacheMutation(args);
    if (mutation.action === "skip") {
      await logWrite("skip", { reason: mutation.reason });
      return false;
    }
    if (mutation.action === "upsert") {
      await db
        .insert(schema.customerColumnSchemasTable)
        .values({
          customer,
          headerSignature: mutation.signature,
          source: "ai",
          parserName: null,
          format: mutation.format,
          columnRoles: mutation.columnRoles,
        })
        .onConflictDoUpdate({
          target: [
            schema.customerColumnSchemasTable.customer,
            schema.customerColumnSchemasTable.headerSignature,
            schema.customerColumnSchemasTable.format,
          ],
          set: {
            columnRoles: mutation.columnRoles,
            source: "ai",
          },
        });
      await logWrite("upsert", {
        format: mutation.format,
        signature: mutation.signature,
      });
      return true;
    }
    // delete-stale
    await db.execute(
      sql`DELETE FROM customer_column_schemas
          WHERE lower(customer) = lower(${customer})
            AND header_signature = ${mutation.signature}
            AND format = ${mutation.format}
            AND source = 'ai'`,
    );
    await logWrite("delete-stale", {
      format: mutation.format,
      signature: mutation.signature,
    });
    return false;
  } catch (err) {
    log.warn({ err, customer, fileName }, "recordAiSchemaIfPossible failed");
    return false;
  }
}

// Prefer the raw badge the AI saw (carried through ParsedPunch.rawBadge
// from imageSupport); fall back to the mapped kfiId for legacy callers.
// `inferColumnRoles` / `inferPdfColumnRoles` only need a string to
// search the document for — when the raw badge isn't available the
// kfiId is a reasonable best-effort needle (works for self-mapping
// customers like Trienda; fails gracefully for others).
function pickRawBadge(p: ParsedPunch): string {
  if (typeof p.rawBadge === "string" && p.rawBadge.trim().length > 0) {
    return p.rawBadge.trim();
  }
  return p.kfiId;
}

/** Test seam: clear all AI-source rows for a customer. */
export async function __clearAiSchemasForCustomer(
  customer: string,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__clearAiSchemasForCustomer is a test seam");
  }
  await db.execute(
    sql`DELETE FROM customer_column_schemas WHERE lower(customer)=lower(${customer}) AND source='ai'`,
  );
}
