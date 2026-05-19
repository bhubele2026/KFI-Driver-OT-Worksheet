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
  },
): {
  badge: number;
  date: number;
  timeIn: number;
  timeOut: number;
  hours?: number | null;
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

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    let badgeCol = -1;
    let dateCol = -1;
    let timeInCol = -1;
    let timeOutCol = -1;
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (v == null) continue;
      const s =
        v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
      if (
        badgeCol < 0 &&
        s.toLowerCase() === badgeNeedle
      ) {
        badgeCol = i;
        continue;
      }
      if (dateCol < 0) {
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
      if (
        timeInCol < 0 &&
        timeInNeedle &&
        s.toUpperCase().includes(timeInNeedle.toUpperCase())
      ) {
        timeInCol = i;
        continue;
      }
      if (
        timeOutCol < 0 &&
        timeOutNeedle &&
        timeOutNeedle !== timeInNeedle &&
        s.toUpperCase().includes(timeOutNeedle.toUpperCase())
      ) {
        timeOutCol = i;
        continue;
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
 */
export function buildEmployeeAnchorRegex(
  lines: string[],
  badge: string,
): string | null {
  if (!badge) return null;
  const esc = escapeRegex(badge);
  // Word-boundary-ish: badge surrounded by start/end or non-alphanumeric.
  const badgeRe = new RegExp(`(^|[^A-Za-z0-9])(${esc})($|[^A-Za-z0-9])`);
  for (const line of lines) {
    const m = badgeRe.exec(line);
    if (!m) continue;
    const idx = m.index + m[1].length;
    const left = line.slice(0, idx);
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
  sample: { rawBadge: string; clockIn: string; clockOut: string; hours: number },
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
  const empRegex = buildEmployeeAnchorRegex(flat, sample.rawBadge);
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
 * After a successful AI extraction on a customer-file upload, derive
 * column roles for the file's layout and upsert a
 * `customer_column_schemas` row keyed on `(customer, signature,
 * format)`. On subsequent uploads with the same header / layout
 * signature the route's `lookupSchema → 'cache'` branch consumes
 * these roles via `readWithRoles` (xlsx) or `readPdfWithRoles` (pdf),
 * skipping AI entirely.
 *
 * No-op for image uploads (no stable signature), when no signature
 * can be computed, when AI returned 0 punches, or when roles can't be
 * confidently inferred. Designed to never throw — failure here only
 * costs the next upload another AI call.
 */
export async function recordAiSchemaIfPossible(args: {
  customer: string;
  fileName: string;
  buffer: Buffer;
  aiResult: ParseResult;
  weekStart: string;
  log: { warn: (obj: object, msg: string) => void };
}): Promise<boolean> {
  const { customer, fileName, buffer, aiResult, weekStart, log } = args;
  try {
    const signature = await computeHeaderSignature(fileName, buffer);
    if (!signature) return false;
    const first = aiResult.punches[0];
    if (!first) return false;
    const lower = fileName.toLowerCase();
    const format: "xlsx" | "pdf" | null =
      lower.endsWith(".xlsx") || lower.endsWith(".xls")
        ? "xlsx"
        : lower.endsWith(".pdf")
          ? "pdf"
          : null;
    if (!format) return false;

    const rawBadge = pickRawBadge(first);
    let roles: unknown;
    if (format === "xlsx") {
      roles = inferColumnRoles(buffer, {
        rawBadge,
        dateIso: first.date,
        clockIn: first.clockIn,
        clockOut: first.clockOut,
      });
    } else {
      const fallbackYear = parseInt(weekStart.slice(0, 4));
      roles = await inferPdfColumnRoles(
        buffer,
        {
          rawBadge,
          clockIn: first.clockIn,
          clockOut: first.clockOut,
          hours: first.hours,
        },
        fallbackYear,
      );
    }
    if (!roles) return false;

    await db
      .insert(schema.customerColumnSchemasTable)
      .values({
        customer,
        headerSignature: signature,
        source: "ai",
        parserName: null,
        format,
        columnRoles: roles as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [
          schema.customerColumnSchemasTable.customer,
          schema.customerColumnSchemasTable.headerSignature,
          schema.customerColumnSchemasTable.format,
        ],
        set: {
          columnRoles: roles as Record<string, unknown>,
          source: "ai",
        },
      });
    return true;
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
