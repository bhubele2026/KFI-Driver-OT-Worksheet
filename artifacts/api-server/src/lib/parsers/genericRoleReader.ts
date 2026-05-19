import * as XLSX from "xlsx";
import { UnmappedIdAccumulator } from "./types.js";
import type { ParseResult, ParsedPunch } from "./types.js";

export interface ColumnRoles {
  badge: number;
  date: number;
  timeIn: number;
  timeOut: number;
  hours?: number | null;
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
    const mapped = idMap[rawBadge];
    if (!mapped || !kfiSet.has(mapped)) {
      unmapped.add(rawBadge, null);
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
