/**
 * Auto-align whole-day driver-punch clock errors (2026-08-05, Brad: "no
 * manual edits — for review it needs to align, it needs to look right all
 * the time").
 *
 * The failure mode (Davidson Alcide, Mon 7/27): a driver's phone/clock sat
 * on the wrong timezone for a day, so BOTH of that day's Connecteam punches
 * landed exactly one hour off — the morning drive appeared to start after
 * the plant shift began, and the afternoon drive an hour after it ended.
 * Durations (and therefore pay) were always right; only the wall-clocks
 * were shifted.
 *
 * The pass is deliberately narrow and deterministic:
 *  - Works one (driver, date) at a time and only shifts THE WHOLE DAY's
 *    driver punches together by exactly ±1 hour (a device-tz error affects
 *    every punch that day).
 *  - Only fires when the day currently looks WRONG (a driver punch overlaps
 *    the customer shift, or a drive-to-shift chain gap sits in the 45–75min
 *    band that a 1-hour error produces) AND the shifted layout is CLEAN
 *    (no overlap, every chain gap ≤ CHAIN_TOLERANCE_MIN) AND the other
 *    direction doesn't also qualify (ambiguity = do nothing).
 *  - Compares in ABSOLUTE time: each punch is converted through its own
 *    dispTz, so a Chicago drive chains correctly against an Eastern-labeled
 *    customer shift.
 *  - Never touches customer rows, manual punches, edited punches, or any
 *    punch whose shift would cross midnight (date bucketing stays stable).
 *
 * Durations are preserved exactly; daily totals, OT split and the Zenople
 * export are unaffected. Runs after Connecteam refresh, after customer-file
 * confirm, and as an audited boot sweep so historical weeks self-heal.
 */
/** pg Pool and Client both satisfy this. */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export const CHAIN_TOLERANCE_MIN = 15;
const BAND_MIN = 45;
const BAND_MAX = 75;

// ---------------------------------------------------------------------------
// Wall-clock ↔ instant (per-punch dispTz, DST-correct, no deps)
// ---------------------------------------------------------------------------

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

function tzOffsetMs(tz: string, utcMs: number): number {
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

/** "YYYY-MM-DD h:MM AM" in `tz` → epoch ms, or null when unparseable. */
export function wallClockToMs(value: string, tz: string): number | null {
  const m = WALL_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, ys, mos, ds, hs, mins, ap] = m;
  let h24 = Number(hs) % 12;
  if (/pm/i.test(ap)) h24 += 12;
  try {
    const guess = Date.UTC(Number(ys), Number(mos) - 1, Number(ds), h24, Number(mins));
    let instant = guess - tzOffsetMs(tz, guess);
    instant = guess - tzOffsetMs(tz, instant);
    return instant;
  } catch {
    return null;
  }
}

/** Shift "YYYY-MM-DD h:MM AM" by whole hours (pure string math, no tz). */
export function shiftWallHours(value: string, hours: number): string | null {
  const m = WALL_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, ys, mos, ds, hs, mins, ap] = m;
  let h24 = Number(hs) % 12;
  if (/pm/i.test(ap)) h24 += 12;
  const base = Date.UTC(Number(ys), Number(mos) - 1, Number(ds), h24, Number(mins));
  const d = new Date(base + hours * 3_600_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  let h = d.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${y}-${mo}-${day} ${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ampm}`;
}

// ---------------------------------------------------------------------------
// Decision (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface AlignPunch {
  id: number;
  source: string;
  clockIn: string;
  clockOut: string;
  dispTz: string | null;
  isManual: boolean;
  edited: boolean | null;
  customer?: string | null;
}

interface Interval {
  start: number;
  end: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Smallest edge-to-edge gap (minutes) between a driver leg and any customer edge. */
function minChainGapMin(driver: Interval, customers: Interval[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const c of customers) {
    best = Math.min(
      best,
      Math.abs(c.start - driver.end) / 60_000, // drive → shift start
      Math.abs(driver.start - c.end) / 60_000, // shift end → drive
    );
  }
  return best;
}

function layoutScore(
  drivers: Interval[],
  customers: Interval[],
): { anyOverlap: boolean; maxGap: number; anyBand: boolean } {
  let anyOverlap = false;
  let maxGap = 0;
  let anyBand = false;
  for (const d of drivers) {
    if (customers.some((c) => overlaps(d, c))) anyOverlap = true;
    const gap = minChainGapMin(d, customers);
    maxGap = Math.max(maxGap, gap);
    if (gap >= BAND_MIN && gap <= BAND_MAX) anyBand = true;
  }
  return { anyOverlap, maxGap, anyBand };
}

/**
 * Decide the whole-day shift (in hours) for a day's driver punches, given
 * that day's customer punches. Returns 0 when nothing should change.
 *
 * `trustedCustomers` (lower-cased names with a saved customer-tz
 * preference) gates the whole decision: when the customer side's timezone
 * label is just the driver default, a mislabeled SHEET produces the exact
 * same 1-hour signature as a mislabeled DEVICE — and the aligner must
 * never "fix" the truthful side (Ladonte Brown / IWG - El Paso,
 * 2026-08-05: Mountain-time sheet labeled Chicago made his correct CT
 * punches look fast). Only a dispatcher-vouched customer tz makes the
 * comparison trustworthy.
 */
export function decideDayShift(
  punches: AlignPunch[],
  defaultTz: string,
  trustedCustomers?: ReadonlySet<string>,
): number {
  const eligible = punches.filter(
    (p) => p.source === "Driver" && !p.isManual && p.edited !== true,
  );
  const customers = punches.filter((p) => p.source === "Customer");
  if (eligible.length === 0 || customers.length === 0) return 0;
  if (trustedCustomers) {
    const allTrusted = customers.every((p) =>
      trustedCustomers.has((p.customer ?? "").trim().toLowerCase()),
    );
    if (!allTrusted) return 0;
  }

  const toInterval = (p: AlignPunch, shiftH: number): Interval | null => {
    const tz = p.dispTz ?? defaultTz;
    const start = wallClockToMs(p.clockIn, tz);
    const end = wallClockToMs(p.clockOut, tz);
    if (start == null || end == null || end <= start) return null;
    return { start: start + shiftH * 3_600_000, end: end + shiftH * 3_600_000 };
  };

  const custIntervals = customers
    .map((p) => toInterval(p, 0))
    .filter((x): x is Interval => x != null);
  if (custIntervals.length === 0) return 0;

  const at = (shiftH: number): { anyOverlap: boolean; maxGap: number; anyBand: boolean } | null => {
    const ds = eligible.map((p) => toInterval(p, shiftH));
    if (ds.some((x) => x == null)) return null;
    return layoutScore(ds as Interval[], custIntervals);
  };

  const current = at(0);
  if (!current) return 0;
  // Day only qualifies when it currently looks WRONG in a 1-hour way.
  if (!current.anyOverlap && !current.anyBand) return 0;

  const clean = (s: { anyOverlap: boolean; maxGap: number } | null) =>
    s != null && !s.anyOverlap && s.maxGap <= CHAIN_TOLERANCE_MIN;

  const minusOk = clean(at(-1));
  const plusOk = clean(at(1));
  if (minusOk === plusOk) return 0; // neither, or ambiguous — leave alone
  return minusOk ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface AutoAlignResult {
  daysShifted: number;
  punchesShifted: number;
  details: string[];
}

/**
 * Align one week (optionally one driver). Reads Driver+Customer punches,
 * decides per (driver, date), and updates the qualifying days' driver
 * punches in place (clock strings only; punch `date` is never changed —
 * days whose shift would cross midnight are skipped).
 */
export async function autoAlignWeek(
  client: Queryable,
  weekStart: string,
  kfiId?: string,
): Promise<AutoAlignResult> {
  const result: AutoAlignResult = { daysShifted: 0, punchesShifted: 0, details: [] };
  const params: unknown[] = [weekStart];
  let where = `week_start = $1`;
  if (kfiId) {
    params.push(kfiId);
    where += ` AND kfi_id = $2`;
  }
  const rows = await client.query<{
    id: number;
    kfi_id: string;
    date: string;
    source: string;
    clock_in: string;
    clock_out: string;
    disp_tz: string | null;
    is_manual: boolean;
    edited: boolean | null;
    customer: string | null;
  }>(
    `SELECT id, kfi_id, date::text, source, clock_in, clock_out, disp_tz, is_manual, edited, customer
       FROM punches WHERE ${where}`,
    params,
  );
  const prefRows = await client.query<{ customer: string }>(
    `SELECT customer FROM customer_tz_preferences`,
  );
  const trustedCustomers = new Set(
    prefRows.rows.map((r) => r.customer.trim().toLowerCase()),
  );
  const byDriverDay = new Map<string, AlignPunch[]>();
  for (const r of rows.rows) {
    const key = `${r.kfi_id}|${r.date}`;
    const arr = byDriverDay.get(key) ?? [];
    arr.push({
      id: r.id,
      source: r.source,
      clockIn: r.clock_in,
      clockOut: r.clock_out,
      dispTz: r.disp_tz,
      isManual: r.is_manual,
      edited: r.edited,
    });
    byDriverDay.set(key, arr);
  }
  for (const [key, punches] of byDriverDay) {
    const shift = decideDayShift(punches, "America/Chicago", trustedCustomers);
    if (shift === 0) continue;
    const targets = punches.filter(
      (p) => p.source === "Driver" && !p.isManual && p.edited !== true,
    );
    // Skip the whole day if any shifted clock would cross midnight (keeps
    // the payroll date bucketing untouched).
    const shifted = targets.map((p) => ({
      id: p.id,
      in: shiftWallHours(p.clockIn, shift),
      out: shiftWallHours(p.clockOut, shift),
    }));
    const [, date] = key.split("|");
    if (
      shifted.some(
        (s) => s.in == null || s.out == null || !s.in.startsWith(date) || !s.out.startsWith(date),
      )
    ) {
      continue;
    }
    for (const s of shifted) {
      await client.query(`UPDATE punches SET clock_in = $1, clock_out = $2 WHERE id = $3`, [
        s.in,
        s.out,
        s.id,
      ]);
    }
    result.daysShifted++;
    result.punchesShifted += shifted.length;
    result.details.push(`${key} ${shift > 0 ? "+" : ""}${shift}h ×${shifted.length}`);
  }
  return result;
}
