// Connecteam parity helpers.
//
// The driver-detail page wants two pieces of information:
//
//   1. For each day in the week, does the engine's computed total match the
//      Connecteam total snapshotted at the most recent /refresh-connecteam?
//   2. Across the whole driver-week, does every snapshotted day match? (This
//      drives the "Matches Connecteam" / "Differs from Connecteam" badge on
//      the Summary panel.)
//
// We compare to a 0.005h tolerance because both sides are rounded to 2dp.
//
// "no snapshot for this day" → not-yet-refreshed; we report `null`, which the
// frontend renders as a neutral state (neither green nor amber). A day that
// has a snapshot of 0 but a positive engine total is treated as a real
// mismatch — the dispatcher manually added a punch on a day Connecteam knows
// nothing about, and that's exactly the kind of divergence the badge exists
// to surface.

const EPS = 0.005;

export type DailyTotalLite = { date: string; totalHours: number };
export type ConnecteamSnapshotRow = { date: string; hours: string | number };

export type DailyParity = {
  date: string;
  /** Engine total for this day (always present). */
  engineHours: number;
  /** Connecteam baseline for this day, or null if no snapshot exists yet. */
  connecteamHours: number | null;
  /** true=match, false=differ, null=no baseline to compare against. */
  matches: boolean | null;
};

export function buildDailyParity(
  dailyTotals: ReadonlyArray<DailyTotalLite>,
  snapshotRows: ReadonlyArray<ConnecteamSnapshotRow>,
  /**
   * True when this driver-week has been refreshed at least once (i.e. there
   * IS a Connecteam baseline to compare against). When true, a day with no
   * snapshot row is treated as "Connecteam reported 0 hours that day" — so
   * a manual punch on a day Connecteam doesn't know about is correctly
   * surfaced as a diff. When false (driver-week never refreshed), every
   * day is reported as `unknown` and the badge stays neutral.
   */
  baselineExists: boolean,
): DailyParity[] {
  const baseline = new Map<string, number>();
  for (const r of snapshotRows) baseline.set(r.date, Number(r.hours));
  return dailyTotals.map((d) => {
    const ct = baseline.get(d.date);
    if (ct === undefined) {
      if (!baselineExists) {
        return {
          date: d.date,
          engineHours: d.totalHours,
          connecteamHours: null,
          matches: null,
        };
      }
      // Baseline exists but has no row for this date → Connecteam knows
      // nothing about this day, so treat it as 0.00h on the Connecteam
      // side. Any positive engine total is a real diff.
      return {
        date: d.date,
        engineHours: d.totalHours,
        connecteamHours: 0,
        matches: Math.abs(d.totalHours) < EPS,
      };
    }
    return {
      date: d.date,
      engineHours: d.totalHours,
      connecteamHours: ct,
      matches: Math.abs(d.totalHours - ct) < EPS,
    };
  });
}

/**
 * Returns true iff every day that has a Connecteam snapshot matches the
 * engine total within tolerance. A driver-week with zero snapshots returns
 * `null` (not-yet-refreshed); the frontend treats null as "no parity claim
 * yet" rather than green or amber.
 */
/**
 * The dispatcher-visible parity badge compares the dashboard against a
 * snapshot taken at the last /refresh-connecteam call. If that snapshot is
 * old, a green "matches" badge can be misleading — Connecteam may have new
 * shifts on its side that the dashboard has no way to know about.
 *
 * Returns `{ stale, ageHours }`:
 * - `ageHours` is null when there's no baseline at all (never refreshed).
 * - `stale` is true when the baseline is older than `thresholdHours`.
 *   Never refreshed → `stale=false` (the unknown badge already says that).
 */
export function computeBaselineStaleness(
  lastRefreshedAt: Date | string | null | undefined,
  now: Date,
  thresholdHours: number,
): { stale: boolean; ageHours: number | null } {
  if (lastRefreshedAt == null) return { stale: false, ageHours: null };
  const refreshedMs =
    typeof lastRefreshedAt === "string"
      ? Date.parse(lastRefreshedAt)
      : lastRefreshedAt.getTime();
  if (!Number.isFinite(refreshedMs)) return { stale: false, ageHours: null };
  const ageHours = Math.max(0, (now.getTime() - refreshedMs) / 3_600_000);
  return { stale: ageHours >= thresholdHours, ageHours };
}

export function summarizeParity(rows: ReadonlyArray<DailyParity>): {
  status: "match" | "differ" | "unknown";
  diffCount: number;
} {
  let snapshotted = 0;
  let diffs = 0;
  for (const r of rows) {
    if (r.matches === null) continue;
    snapshotted++;
    if (!r.matches) diffs++;
  }
  if (snapshotted === 0) return { status: "unknown", diffCount: 0 };
  return { status: diffs === 0 ? "match" : "differ", diffCount: diffs };
}
