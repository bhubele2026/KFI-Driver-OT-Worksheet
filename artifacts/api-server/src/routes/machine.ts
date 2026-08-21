import { Router, type IRouter } from "express";
import { eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { computeDriverTotals } from "../lib/hoursEngine.js";
import { requirePulseKey } from "./pulse.js";

/**
 * Per-driver, per-week hours for the warehouse.
 *
 * ⭐ WHY THIS IS NOT PART OF /pulse. Pulse is aggregate by design — counts,
 * readiness, totals — and it says so. This carries a row per human, with the
 * Zenople PersonId that identifies them. Bolting per-person rows onto pulse
 * would quietly change what that endpoint is, and every consumer's idea of how
 * sensitive it is. Two surfaces, two contracts, one shared key.
 *
 * ⭐ WHY IT EXISTS AT ALL. Housing's Transportation board knows who we THINK
 * drives each van. Only this app knows who was actually PAID to drive: it owns
 * the Connecteam punches, and `source = 'Driver'` is the whole definition.
 * Samsara can say a van moved but never who moved it — the account has no
 * driver data at all. So this feed is the only path to that answer, and the
 * integration contract routes it through the warehouse rather than letting
 * Housing reach in here.
 *
 * ⚠️ THE NUMBERS COME FROM `computeDriverTotals`, THE SAME FUNCTION THE
 * DASHBOARD AND THE ZENOPLE EXPORT USE. Not a re-derivation, not a SUM() over
 * punches — the 40-hour split is chronological across the combined driver and
 * customer stream and back-solved so the four buckets reconcile exactly, and a
 * second implementation would disagree with payroll at the edges.
 *
 * ⚠️ NO SSNs AND NO RATES. `driver_payroll_profiles` holds both; this reads the
 * PersonId out of it and nothing else. A join key is not a pay rate.
 */
const router: IRouter = Router();

interface DriverWeekRow {
  weekStart: string;
  kfiId: string;
  /** Zenople PersonId — the ONLY key anything downstream is allowed to join on. */
  personId: number | null;
  name: string;
  /** What this app files the driver under (override → roster). */
  customer: string | null;
  /** Zenople's own Organization label, which is what the warehouse keys on. */
  zenopleCustomer: string | null;
  driverRt: number;
  driverOt: number;
  customerHours: number;
  reviewed: boolean;
}

router.get("/machine/driver-weeks", requirePulseKey, async (req, res) => {
  // Default to a window rather than everything: this is polled nightly, and a
  // full-history response would grow without bound for no consumer's benefit.
  const since = String(req.query["since"] ?? "").trim();
  const weeksBack = Math.min(Math.max(Number(req.query["weeks"] ?? 8) || 8, 1), 52);

  const allWeeks = await db
    .select({ startDate: schema.weeksTable.startDate })
    .from(schema.weeksTable)
    .orderBy(schema.weeksTable.startDate);

  // ⚠️ DROP WEEKS THAT HAVE NOT STARTED YET. The weeks table carries three rows
  // dated 2031 with no punches on them — somebody typed a year wrong — and they
  // sort to the top, so "the most recent N weeks" returned 2031 and no data at
  // all. A week that has not begun cannot contain paid driving, so the filter is
  // a statement about reality rather than a workaround for those three rows.
  const today = new Date().toISOString().slice(0, 10);
  const real = allWeeks.filter((w) => w.startDate <= today);

  const weekStarts = (
    /^\d{4}-\d{2}-\d{2}$/.test(since)
      ? real.filter((w) => w.startDate >= since)
      : real.slice(-weeksBack)
  ).map((w) => w.startDate);

  if (weekStarts.length === 0) {
    res.json({ ok: true, service: "kfi-ot-worksheet", weeks: [], rows: [] });
    return;
  }

  const [punches, drivers, profiles, overrides, reviewed] = await Promise.all([
    db.select().from(schema.punchesTable).where(inArray(schema.punchesTable.weekStart, weekStarts)),
    db.select().from(schema.driversTable),
    db.select().from(schema.driverPayrollProfilesTable),
    db.select().from(schema.driverCustomerOverridesTable),
    db
      .select()
      .from(schema.reviewedDriversTable)
      .where(inArray(schema.reviewedDriversTable.weekStart, weekStarts)),
  ]);

  const driverBy = new Map(drivers.map((d) => [d.kfiId, d]));
  const profileBy = new Map(profiles.map((p) => [p.kfiId, p]));
  const overrideBy = new Map(overrides.map((o) => [o.kfiId, o.overrideCustomer]));
  const reviewedBy = new Set(reviewed.filter((r) => r.status === "good").map((r) => `${r.weekStart}|${r.kfiId}`));

  // (week, driver) -> punches. A driver with no punches in a week produces NO
  // row: "worked zero hours" and "was not on the roster that week" are
  // different facts, and inventing a zero row would let a consumer read the
  // second as the first.
  const byPair = new Map<string, typeof punches>();
  for (const p of punches) {
    const key = `${p.weekStart}|${p.kfiId}`;
    const arr = byPair.get(key) ?? [];
    arr.push(p);
    byPair.set(key, arr);
  }

  const rows: DriverWeekRow[] = [];
  for (const [key, ps] of byPair) {
    const [weekStart, kfiId] = key.split("|") as [string, string];
    const t = computeDriverTotals(ps);
    const d = driverBy.get(kfiId);
    const prof = profileBy.get(kfiId);
    rows.push({
      weekStart,
      kfiId,
      personId: prof?.personId ?? null,
      name: d?.name ?? kfiId,
      customer: overrideBy.get(kfiId) ?? d?.customer ?? null,
      zenopleCustomer: prof?.zenopleCustomer ?? null,
      driverRt: t.driverRt,
      driverOt: t.driverOt,
      customerHours: t.totalCustomer,
      reviewed: reviewedBy.has(key),
    });
  }
  rows.sort((a, b) => (a.weekStart === b.weekStart ? a.name.localeCompare(b.name) : a.weekStart.localeCompare(b.weekStart)));

  // ⚠️ The coverage hole travels WITH the data, not in a separate dashboard.
  // A row whose personId is null can never be joined to a van, and a consumer
  // that cannot see how many of those there are will quietly report a partial
  // answer as a complete one.
  const nullPersonIds = rows.filter((r) => r.personId == null).length;

  res.json({
    ok: true,
    service: "kfi-ot-worksheet",
    weeks: weekStarts,
    rows,
    gaps: { nullPersonIds, driversTotal: drivers.length },
  });
});

export { router as machineRouter };
