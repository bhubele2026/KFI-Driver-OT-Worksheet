// Timezone-aware time helpers shared by the Connecteam ingest, the parsers,
// and the hours engine. We store every clock-in/out as a *display-tz wall-clock
// string* of the form "YYYY-MM-DD H:MM AM" or "YYYY-MM-DD HH:MM:SS".
// All arithmetic on those strings treats the wall-clock as UTC for the
// purposes of relative ordering — which is correct as long as both ends of
// the comparison live in the same display timezone (the dispatcher only
// merges punches from a single driver, who lives in a single tz).

export const CT_TZ = "America/Chicago";

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

/** Format an arbitrary date-ish value as "YYYY-MM-DD HH:MM:SS" in local time. */
export function fmtDT(v: unknown): string {
  if (!v) return "";
  let d: Date;
  if (v instanceof Date) d = v;
  else d = new Date(v as string);
  if (isNaN(d.getTime())) return String(v).slice(0, 19);
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yr}-${mo}-${dy} ${hh}:${mm}:${ss}`;
}
