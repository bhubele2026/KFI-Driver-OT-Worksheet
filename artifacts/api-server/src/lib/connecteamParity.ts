// Connecteam parity helpers.
//
// The driver-detail page wants two pieces of information:
//
//   1. For each day in the week, does the dashboard's computed total match
//      (Connecteam snapshot + Customer-imported hours) for that day?
//   2. Across the whole driver-week, does every snapshotted day match? (This
//      drives the "Matches Connecteam" / "Differs from Connecteam" badge on
//      the Summary panel.)
//
// The reconciliation the dispatcher actually wants is: the two source
// documents (Connecteam punches + customer-imported time files) should add
// up to whatever the dashboard is about to pay. Any day where
// `(CT + Customer) != Dashboard` is a real discrepancy worth surfacing —
// it means either a manual edit, an edited punch, or a CT shift that has
// no matching customer record (or vice versa).
//
// We compare to a 0.005h tolerance because all sides are rounded to 2dp.
//
// "no snapshot for this day" → not-yet-refreshed; we report `null`, which the
// frontend renders as a neutral state (neither green nor amber). A day that
// has a snapshot of 0 but a positive engine total is treated as a real
// mismatch — the dispatcher manually added a punch on a day Connecteam knows
// nothing about, and that's exactly the kind of divergence the badge exists
// to surface.

const EPS = 0.005;

export type DailyTotalLite = {
  date: string;
  totalHours: number;
  customerHours: number;
};
export type ConnecteamSnapshotRow = { date: string; hours: string | number };

export type DailyParity = {
  date: string;
  /** Customer-imported hours for this day. */
  customerHours: number;
  /** Dashboard's computed total for this day (Driver + Customer merged). */
  dashboardHours: number;
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
    const customer = d.customerHours;
    const dashboard = d.totalHours;
    if (ct === undefined) {
      if (!baselineExists) {
        return {
          date: d.date,
          customerHours: customer,
          dashboardHours: dashboard,
          connecteamHours: null,
          matches: null,
        };
      }
      // Baseline exists but has no row for this date → Connecteam knows
      // nothing about this day, so treat it as 0.00h on the Connecteam
      // side. The day matches iff the dashboard total equals the
      // customer-imported hours (CT contributes nothing).
      return {
        date: d.date,
        customerHours: customer,
        dashboardHours: dashboard,
        connecteamHours: 0,
        matches: Math.abs(dashboard - customer) < EPS,
      };
    }
    return {
      date: d.date,
      customerHours: customer,
      dashboardHours: dashboard,
      connecteamHours: ct,
      matches: Math.abs(dashboard - (ct + customer)) < EPS,
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
