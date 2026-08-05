/**
 * Wall-clock timezone conversion for punch display (no external deps).
 *
 * Punches store LOCAL wall-clock strings ("YYYY-MM-DD h:MM AM") tagged with
 * the tz they were recorded in (`dispTz`). To view a punch in another zone
 * we find the real instant that wall-clock names in its source zone, then
 * re-render that instant in the target zone. Display-only — hours math in
 * the app is tz-agnostic and never uses this.
 */

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

function tzOffsetMs(tz: string, utcMs: number): number {
  // Offset of `tz` at the given instant, via Intl (DST-correct).
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour === 24 ? 0 : (parts.hour ?? 0),
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return asUtc - utcMs;
}

/** The UTC instant whose wall-clock in `tz` matches the given components. */
function wallClockToInstant(
  y: number,
  mo: number,
  d: number,
  h24: number,
  min: number,
  tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h24, min);
  // Two passes converge across DST boundaries.
  let instant = guess - tzOffsetMs(tz, guess);
  instant = guess - tzOffsetMs(tz, instant);
  return instant;
}

/**
 * Convert "YYYY-MM-DD h:MM AM" from one IANA zone to another, returning the
 * same string shape (so downstream cross-midnight formatting keeps working).
 * Returns the input unchanged when it doesn't parse or zones are equal.
 */
export function shiftWallClock(value: string, fromTz: string, toTz: string): string {
  if (!fromTz || !toTz || fromTz === toTz) return value;
  const m = WALL_RE.exec(value.trim());
  if (!m) return value;
  const [, ys, mos, ds, hs, mins, ap] = m;
  let h24 = Number(hs) % 12;
  if (/pm/i.test(ap)) h24 += 12;
  let instant: number;
  try {
    instant = wallClockToInstant(Number(ys), Number(mos), Number(ds), h24, Number(mins), fromTz);
  } catch {
    return value;
  }
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: toTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(instant))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const ampm = (parts.dayPeriod ?? "AM").toUpperCase();
  return `${parts.year}-${parts.month}-${parts.day} ${Number(parts.hour)}:${parts.minute} ${ampm}`;
}

/** Short human label for an IANA zone ("America/New_York" → "New York"). */
export function tzShortLabel(tz: string): string {
  const city = tz.split("/").pop() ?? tz;
  return city.replace(/_/g, " ");
}
