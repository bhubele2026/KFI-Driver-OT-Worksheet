import * as XLSX from "xlsx";
import { UnmappedIdAccumulator } from "./types.js";
import type { ParseResult, ParsedPunch } from "./types.js";
import { extractPdfLinesByPage } from "./schemaSignature.js";

export interface ColumnRoles {
  badge: number;
  date: number;
  timeIn: number;
  timeOut: number;
  hours?: number | null;
  /**
   * Index of the column carrying the driver name on the source row, when
   * the AI run that recorded the recipe was able to locate one (Task #338).
   * Optional: older cached recipes written before this field existed will
   * be missing it, and the reader must tolerate that — in that case the
   * unmapped panel falls back to "(no name on doc)" until the next
   * successful AI re-run for the customer rewrites the recipe with the
   * column included.
   */
  name?: number | null;
}

function isColumnRoles(v: unknown): v is ColumnRoles {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.badge === "number" &&
    typeof r.date === "number" &&
    typeof r.timeIn === "number" &&
    typeof r.timeOut === "number"
  );
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function normalizeDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function normalizeTime(v: unknown, dateIso: string): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const h = v.getUTCHours();
    const min = v.getUTCMinutes();
    const ampm = h < 12 ? "AM" : "PM";
    const hr12 = h % 12 === 0 ? 12 : h % 12;
    return `${dateIso} ${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
  }
  const s = String(v).trim();
  if (!s) return null;
  // "H:MM AM/PM" or "HH:MM"
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const tag = m[3]?.toUpperCase();
  if (tag) {
    return `${dateIso} ${h}:${String(min).padStart(2, "0")} ${tag}`;
  }
  const ampm = h < 12 ? "AM" : "PM";
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${dateIso} ${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
}

function diffHours(clockIn: string, clockOut: string): number {
  const parse = (s: string) => {
    const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}) (AM|PM)$/);
    if (!m) return NaN;
    let h = parseInt(m[2]);
    const min = parseInt(m[3]);
    if (m[4] === "PM" && h !== 12) h += 12;
    if (m[4] === "AM" && h === 12) h = 0;
    return Date.UTC(
      parseInt(m[1].slice(0, 4)),
      parseInt(m[1].slice(5, 7)) - 1,
      parseInt(m[1].slice(8, 10)),
      h,
      min,
    );
  };
  const a = parse(clockIn);
  const b = parse(clockOut);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round(((b - a) / 36e5) * 100) / 100;
}

/**
 * Read an xlsx using AI-discovered column roles. Used by the per-row
 * upload pipeline's `cache` branch in `/extract-customer-file`: when a
 * prior successful AI extraction wrote `column_roles` for the file's
 * header signature, subsequent uploads with the same layout skip AI
 * and use this reader instead.
 *
 * Returns null if the role shape is malformed or the workbook is
 * unreadable — caller falls through to AI in that case.
 */
export function readWithRoles(
  customer: string,
  buffer: Buffer,
  columnRoles: unknown,
  kfiSet: Set<string>,
  idMap: Record<string, string>,
  weekStart: string,
  weekEnd: string,
): ParseResult | null {
  if (!isColumnRoles(columnRoles)) return null;
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
  const unmapped = new UnmappedIdAccumulator();
  const punches: ParsedPunch[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const rawBadge = cellToString(row[columnRoles.badge]);
    if (!rawBadge) continue;
    const dateIso = normalizeDate(row[columnRoles.date]);
    if (!dateIso) continue;
    if (dateIso < weekStart || dateIso > weekEnd) continue;
    const clockIn = normalizeTime(row[columnRoles.timeIn], dateIso);
    const clockOut = normalizeTime(row[columnRoles.timeOut], dateIso);
    if (!clockIn || !clockOut) continue;
    // Resolve badge → kfiId. Aliases take precedence (a customer's
    // external employee number remapped to a KFI driver); otherwise
    // fall through to the badge itself if it's already a real
    // kfi_id (matches the AI path in `imageSupport.resolveKfiId`,
    // which accepts kfiSet.has(badge) as a self-mapping so files
    // that ship driver kfi_ids in the badge column don't need a
    // dummy alias per driver).
    const aliased = idMap[rawBadge];
    let mapped: string | null = null;
    if (aliased && kfiSet.has(aliased)) mapped = aliased;
    else if (kfiSet.has(rawBadge)) mapped = rawBadge;
    if (!mapped) {
      // Carry the driver name through when the cached recipe knows
      // which column held it (Task #338). Older recipes written before
      // the name column was tracked simply fall back to null and the
      // panel renders "(no name on doc)" until the next AI re-run
      // rewrites the recipe with the column included.
      let sampleName: string | null = null;
      if (columnRoles.name != null) {
        const raw = cellToString(row[columnRoles.name]).trim();
        if (raw) sampleName = raw;
      }
      unmapped.add(rawBadge, sampleName);
      continue;
    }
    let hours: number | null = null;
    if (columnRoles.hours != null && row[columnRoles.hours] != null) {
      const h = Number(row[columnRoles.hours]);
      if (!isNaN(h) && h > 0) hours = Math.round(h * 100) / 100;
    }
    if (hours == null) hours = diffHours(clockIn, clockOut);
    if (hours <= 0) continue;
    punches.push({
      kfiId: mapped,
      customer,
      date: dateIso,
      clockIn,
      clockOut,
      hours,
      payType: "Reg",
    });
  }
  return { customer, punches, unmappedIds: unmapped.toArray() };
}

/* ============================================================
 * PDF role reader (Task #257)
 *
 * Mirrors `readWithRoles` for PDFs. After a successful AI
 * extraction on a PDF, `recordAiSchemaIfPossible` infers two
 * regex templates:
 *   - `employeeAnchor`: matches a "new employee" line and
 *     captures the raw badge id in group 1.
 *   - `dataRow`: matches a per-punch line and captures the
 *     in-time (group 1) and out-time (group 2), optionally
 *     followed by hours (group 3).
 *
 * On subsequent uploads with the same PDF layout signature, the
 * route calls `readPdfWithRoles` instead of Gemini — the reader
 * walks each line, switches the current badge on anchor hits,
 * and emits punches on dataRow hits. Dates are extracted from
 * the same data line via a set of standard date regexes (ISO,
 * M/D, "May 12, 2026", "(05/12)" DeLallo-style); when no date
 * is on the data line itself, the reader looks back at the
 * previous 5 lines for the most recent date.
 *
 * Returns null on malformed roles or unreadable PDF (forces AI
 * re-run, which then overwrites the stale cache row).
 * ============================================================ */

export interface PdfColumnRoles {
  format: "pdf";
  employeeAnchor: { regex: string; flags?: string };
  dataRow: { regex: string; flags?: string };
  /** Year used to backfill dates that omit it (e.g. DeLallo "(05/12)"). */
  fallbackYear?: number;
}

function isPdfColumnRoles(v: unknown): v is PdfColumnRoles {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (r.format !== "pdf") return false;
  const a = r.employeeAnchor as { regex?: unknown } | undefined;
  const d = r.dataRow as { regex?: unknown } | undefined;
  return (
    typeof a?.regex === "string" &&
    typeof d?.regex === "string" &&
    a.regex.length > 0 &&
    d.regex.length > 0
  );
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Pull an ISO date out of a single PDF text line, trying the formats
 * we see across our PDF customers in priority order:
 *   - ISO `YYYY-MM-DD`
 *   - `Month Day, Year` (Adient)
 *   - `Month Day` with year supplied via `fallbackYear` (rare)
 *   - `M/D/YYYY` or `M/D/YY`
 *   - `(M/D)` with year supplied via `fallbackYear` (DeLallo)
 */
function findDateInLine(line: string, fallbackYear?: number): string | null {
  let m = line.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = line.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{1,2}),?\s*(\d{4})\b/i,
  );
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return `${m[3]}-${mo}-${m[2].padStart(2, "0")}`;
  }
  m = line.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = line.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m && fallbackYear) {
    return `${fallbackYear}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = line.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{1,2})\b/i,
  );
  if (m && fallbackYear) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return `${fallbackYear}-${mo}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function normalizeTimeStr(raw: string, dateIso: string): string | null {
  const m = raw
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const tag = m[3]?.toUpperCase();
  if (tag) {
    return `${dateIso} ${h}:${String(min).padStart(2, "0")} ${tag}`;
  }
  const ampm = h < 12 ? "AM" : "PM";
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${dateIso} ${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/**
 * Read a PDF using AI-discovered employee-anchor and data-row regex
 * templates. See module header for protocol. Walks each page's lines
 * in order. Returns null only if the role shape is malformed or the
 * PDF is unreadable — the route falls through to AI in that case,
 * which will overwrite this cache row.
 */
export async function readPdfWithRoles(
  customer: string,
  buffer: Buffer,
  columnRoles: unknown,
  kfiSet: Set<string>,
  idMap: Record<string, string>,
  weekStart: string,
  weekEnd: string,
): Promise<ParseResult | null> {
  if (!isPdfColumnRoles(columnRoles)) return null;
  const pages = await extractPdfLinesByPage(buffer);
  if (!pages) return null;

  let employeeRe: RegExp;
  let dataRe: RegExp;
  try {
    employeeRe = new RegExp(
      columnRoles.employeeAnchor.regex,
      columnRoles.employeeAnchor.flags ?? "",
    );
    dataRe = new RegExp(
      columnRoles.dataRow.regex,
      columnRoles.dataRow.flags ?? "",
    );
  } catch {
    return null;
  }

  const unmapped = new UnmappedIdAccumulator();
  const punches: ParsedPunch[] = [];
  const fallbackYear =
    columnRoles.fallbackYear ?? parseInt(weekStart.slice(0, 4));

  for (const lines of pages) {
    let currentRawBadge: string | null = null;
    let currentKfiId: string | null = null;
    let currentSampleName: string | null = null;
    let currentMapped = false;
    let lastSeenDate: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const eMatch = employeeRe.exec(line);
      employeeRe.lastIndex = 0;
      // Prefer named captures (Task #341) so the recipe's textual
      // ordering of name vs badge doesn't matter; fall back to
      // positional group 1 (legacy badge-only recipes) and group 2
      // (rare positional name).
      const badgeRaw =
        (eMatch?.groups?.badge ?? eMatch?.[1] ?? "").trim();
      if (eMatch && badgeRaw) {
        currentRawBadge = badgeRaw;
        currentSampleName =
          (eMatch.groups?.name ?? eMatch[2] ?? "").trim() || null;
        const mapped = idMap[currentRawBadge];
        if (mapped && kfiSet.has(mapped)) {
          currentKfiId = mapped;
          currentMapped = true;
        } else {
          currentKfiId = null;
          currentMapped = false;
          unmapped.add(currentRawBadge, currentSampleName);
        }
        continue;
      }
      // Cheap date pre-scan so multi-line PDFs (date on its own line)
      // still know the current date when the punch line lands.
      const lineDate = findDateInLine(line, fallbackYear);
      if (lineDate) lastSeenDate = lineDate;

      if (!currentMapped || !currentKfiId) continue;

      const dMatch = dataRe.exec(line);
      dataRe.lastIndex = 0;
      if (!dMatch) continue;
      const inRaw = (dMatch[1] ?? "").trim();
      const outRaw = (dMatch[2] ?? "").trim();
      if (!inRaw || !outRaw) continue;

      // Try date on this line first, otherwise the most recent line.
      const dateIso = lineDate ?? lastSeenDate;
      if (!dateIso) continue;
      if (dateIso < weekStart || dateIso > weekEnd) continue;

      const clockIn = normalizeTimeStr(inRaw, dateIso);
      const clockOut = normalizeTimeStr(outRaw, dateIso);
      if (!clockIn || !clockOut) continue;

      let hours: number | null = null;
      const hoursRaw = (dMatch[3] ?? "").trim();
      if (hoursRaw) {
        const h = parseFloat(hoursRaw);
        if (!isNaN(h) && h > 0 && h < 25) hours = Math.round(h * 100) / 100;
      }
      if (hours == null) hours = diffHours(clockIn, clockOut);
      if (!(hours > 0)) continue;

      punches.push({
        kfiId: currentKfiId,
        customer,
        date: dateIso,
        clockIn,
        clockOut,
        hours,
        payType: "Reg",
      });
    }
  }

  return { customer, punches, unmappedIds: unmapped.toArray() };
}
