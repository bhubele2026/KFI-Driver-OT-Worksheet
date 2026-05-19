// Timezone-aware time helpers shared by the Connecteam ingest, the parsers,
// and the hours engine. We store every clock-in/out as a *display-tz wall-clock
// string* of the form "YYYY-MM-DD H:MM AM" or "YYYY-MM-DD HH:MM:SS".
// All arithmetic on those strings treats the wall-clock as UTC for the
// purposes of relative ordering — which is correct as long as both ends of
// the comparison live in the same display timezone (the dispatcher only
// merges punches from a single driver, who lives in a single tz).

export const CT_TZ = "America/Chicago";

/**
 * Display timezones the dispatcher is allowed to assign to a driver or
 * customer upload. Kept short on purpose — these are the only zones the
 * KFI roster has ever needed. Add a new one here when a driver moves.
 */
export const ALLOWED_TZS = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
] as const;

export type AllowedTz = (typeof ALLOWED_TZS)[number];

export function isAllowedTz(tz: unknown): tz is AllowedTz {
  return (
    typeof tz === "string" && (ALLOWED_TZS as readonly string[]).includes(tz)
  );
}

/** Convert a UTC ms timestamp into "YYYY-MM-DD H:MM AM" in the given tz. */
export function msToLocalStr(ms: number, tz: string): string {
  const d = new Date(ms);
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: tz });
  const timeStr = d.toLocaleString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${dateStr} ${timeStr}`;
}

/** Extract the calendar date (YYYY-MM-DD) of a UTC ms timestamp in tz. */
export function msToLocalDate(ms: number, tz: string): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * Parse a stored wall-clock string back into a sortable ms value. The
 * absolute value is meaningless (we don't apply any tz offset); the *relative*
 * order of two parses from the same tz is correct, which is all the hours
 * engine needs.
 */
export function localStrToSortMs(str: string | null | undefined): number | null {
  if (!str) return null;
  if (str.includes("T") || /Z$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d+):(\d+)(?::(\d+))?\s*([AP]M)?$/i);
  if (!m) return null;
  let hh = parseInt(m[4]);
  const mm = parseInt(m[5]);
  const ss = parseInt(m[6] ?? "0");
  const ap = (m[7] ?? "").toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  return Date.UTC(
    parseInt(m[1]),
    parseInt(m[2]) - 1,
    parseInt(m[3]),
    hh,
    mm,
    ss,
  );
}

/** Number of hours between two stored wall-clock strings in the same tz. */
export function diffHours(start: string, end: string): number {
  const a = localStrToSortMs(start);
  const b = localStrToSortMs(end);
  if (a === null || b === null) return 0;
  return Math.max(0, (b - a) / 3_600_000);
}

/** Parse "YYYY-MM-DD" → UTC ms midnight. */
export function isoDateToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Add days to a "YYYY-MM-DD" string. */
export function addDays(iso: string, days: number): string {
  const ms = isoDateToUtcMs(iso) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Inclusive list of dates from start..end. */
export function listDates(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** Saturday end of a Sunday-anchored payroll week. */
export function weekEndOf(weekStart: string): string {
  return addDays(weekStart, 6);
}

/**
 * Snap any ISO date to the Sunday of its payroll week (Sun→Sat).
 * KFI runs payroll Sunday through Saturday, so every weekStart in the
 * system is a Sunday.
 */
export function sundayOf(iso: string): string {
  const ms = isoDateToUtcMs(iso);
  const dow = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
  return addDays(iso, -dow);
}

/** Format an arbitrary date-ish value as YYYY-MM-DD. */
export function fmtDate(v: unknown): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Convert 24-hour hour into 12-hour h + AM/PM suffix (no leading zero). */
function to12Hour(hh: number, mm: number | string): string {
  const m = typeof mm === "number" ? String(mm).padStart(2, "0") : mm;
  const ap = hh >= 12 ? "PM" : "AM";
  let h = hh % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ap}`;
}

/**
 * Format an arbitrary date-ish value as "YYYY-MM-DD h:MM AM/PM" in local time.
 *
 * Tolerates:
 *   - Date objects (Excel datetime cells with cellDates: true)
 *   - ISO strings parseable by `new Date(...)`
 *   - Combined wall-clock strings the parsers concatenate themselves, in
 *     either 24-hour ("YYYY-MM-DD HH:MM[:SS]") or 12-hour
 *     ("YYYY-MM-DD H:MM AM/PM"; with or without leading-zero hour) form
 *   - Excel serial numbers
 *
 * Idempotent — feeding the formatter its own output round-trips unchanged.
 */
export function fmtDT(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") {
    const s = v.trim();
    // Already in our target shape (with or without leading-zero hour).
    let m = s.match(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/,
    );
    if (m) {
      const h = parseInt(m[2], 10);
      const ap = m[4].toUpperCase() + "M";
      return `${m[1]} ${h}:${m[3]} ${ap}`;
    }
    // 24-hour combined wall-clock string, optionally with seconds.
    m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (m) {
      const hh = parseInt(m[2], 10);
      return `${m[1]} ${to12Hour(hh, m[3])}`;
    }
    // Anything else: hand to Date.
    const d = new Date(s);
    if (isNaN(d.getTime())) return s.slice(0, 19);
    return fmtDateLocal(d);
  }
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return "";
    return fmtDateLocal(v);
  }
  if (typeof v === "number") {
    // Excel serial (days since 1899-12-30, UTC-naive).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dy = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${dy} ${to12Hour(d.getUTCHours(), d.getUTCMinutes())}`;
  }
  return String(v);
}

function fmtDateLocal(d: Date): string {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${dy} ${to12Hour(d.getHours(), d.getMinutes())}`;
}

/**
 * Convert any stored wall-clock time portion (the part after the date) to the
 * `h:MM AM/PM` shape. Tolerates legacy 24-hour `HH:MM[:SS]` rows so the UI
 * can display old data without a backfill, and passes already-formatted
 * 12-hour strings through unchanged.
 */
export function ensureTime12(time: string): string {
  const s = time.trim();
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (m12) {
    const h = parseInt(m12[1], 10);
    return `${h}:${m12[2]} ${m12[3].toUpperCase()}M`;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m24) return to12Hour(parseInt(m24[1], 10), m24[2]);
  return s;
}
