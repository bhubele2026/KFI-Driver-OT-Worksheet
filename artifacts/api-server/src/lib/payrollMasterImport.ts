/**
 * Assembling and cleaning the Master External import file.
 *
 * Two jobs Monday afternoon, both currently done by filtering a spreadsheet and
 * deleting rows by hand: pulling out the people who reported no hours, and
 * removing driver pay units before the file goes to Zenople.
 */

export type MasterRow = {
  customer: string;
  person: string;
  personId: number;
  transactionCode: string;
  /** ⚠️ Blank and 0 both mean "no hours" and must be treated alike. */
  payUnit: number | null;
  billUnit?: number | null;
  assignmentId?: number | null;
};

const isRt = (r: MasterRow): boolean => r.transactionCode === "RT";
const noHours = (v: number | null | undefined): boolean => v == null || v === 0;

/**
 * ⚠️ Martin Ramirez Cruz is removed from the OPS email, not from the file.
 *
 * The instructions say "REMOVE Martin from this list" when sending the no-hours
 * email — he is not billable, so his having no customer hours is expected and
 * asking Operations about him every week is noise. He still has to come out of
 * the import like anyone else.
 */
export const NO_HOURS_EMAIL_EXCLUSIONS: ReadonlyMap<number, string> = new Map([
  [2003940, "Martin Ramirez Cruz — not billable, expected to have no customer hours"],
]);

export type NoHoursPerson = {
  personId: number;
  person: string;
  customer: string;
  /** True when this person is deliberately left off the Operations email. */
  excludedFromEmail: boolean;
  excludeReason?: string;
};

/**
 * Everyone whose RT row carries no hours.
 *
 * Keyed off the RT row specifically, per the instructions — someone can hold a
 * fringe or bonus row and still have worked nothing.
 */
export function extractNoHours(rows: MasterRow[]): NoHoursPerson[] {
  const seen = new Set<number>();
  const out: NoHoursPerson[] = [];
  for (const r of rows) {
    if (!isRt(r) || !noHours(r.payUnit) || seen.has(r.personId)) continue;
    seen.add(r.personId);
    const reason = NO_HOURS_EMAIL_EXCLUSIONS.get(r.personId);
    out.push({
      personId: r.personId, person: r.person, customer: r.customer,
      excludedFromEmail: reason !== undefined,
      ...(reason ? { excludeReason: reason } : {}),
    });
  }
  return out.sort((a, b) =>
    a.customer.localeCompare(b.customer) || a.person.localeCompare(b.person));
}

/** What Operations actually gets asked about. */
export function noHoursEmailList(people: NoHoursPerson[]): NoHoursPerson[] {
  return people.filter((p) => !p.excludedFromEmail);
}

/**
 * Remove the no-hours people from the import.
 *
 * ⚠️ EVERY row for that person goes, not just the RT one. The instructions say
 * to delete "the row that is highlighted (with RT) and the OT row for the same
 * person if any" — leaving an orphan OT row behind pays overtime to someone who
 * reported no regular hours at all.
 */
export function removeNoHoursPeople(
  rows: MasterRow[], people: NoHoursPerson[],
): { rows: MasterRow[]; removed: number } {
  const ids = new Set(people.map((p) => p.personId));
  const kept = rows.filter((r) => !ids.has(r.personId));
  return { rows: kept, removed: rows.length - kept.length };
}

/**
 * ⚠️ PersonIds that legitimately do NOT appear on the master.
 *
 * The driver-removal step matches driver PersonIds against the import file, and
 * these four never match. That is expected, not an error: three of them record
 * time in Zenople rather than on a customer timesheet, and Martin is not
 * billable. Naming them is the difference between a clean check and four
 * unexplained misses that get shrugged at every week — and a shrug is how a
 * real miss gets missed.
 */
export const EXPECTED_UNMATCHED_DRIVER_IDS: ReadonlyMap<number, string> = new Map([
  [2004462, "Uriel Parra — records time in Zenople"],
  [2003940, "Martin Ramirez Cruz — not billable"],
  [2003762, "Felix Arroyo Colon — records time in Zenople"],
  [2004067, "Ramon Almeida Ruiz — records time in Zenople"],
]);

export type DriverRemovalPlan = {
  /** Driver ids found on the master — their pay units come off. */
  matched: number[];
  /** Driver ids not on the master, and expected not to be. */
  expectedUnmatched: Array<{ personId: number; reason: string }>;
  /** ⚠️ Driver ids not on the master and NOT expected. Investigate these. */
  unexpectedUnmatched: number[];
  /** Per-customer driver hours coming out, for the adjustment columns. */
  adjustments: Array<{ customer: string; driverRt: number; driverOt: number }>;
  totals: { driverRt: number; driverOt: number };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Plan the driver-time removal.
 *
 * Deliberately a PLAN rather than a mutation: the instructions are emphatic
 * that the file is saved before any driver hours come out, so the tile shows
 * what will change and the removal is a separate, deliberate act.
 */
export function planDriverRemoval(
  master: MasterRow[], driverPersonIds: number[],
): DriverRemovalPlan {
  const drivers = new Set(driverPersonIds);
  const onMaster = new Set(master.map((r) => r.personId));

  const matched: number[] = [];
  const expectedUnmatched: Array<{ personId: number; reason: string }> = [];
  const unexpectedUnmatched: number[] = [];

  for (const id of drivers) {
    if (onMaster.has(id)) { matched.push(id); continue; }
    const reason = EXPECTED_UNMATCHED_DRIVER_IDS.get(id);
    if (reason) expectedUnmatched.push({ personId: id, reason });
    else unexpectedUnmatched.push(id);
  }

  const byCustomer = new Map<string, { driverRt: number; driverOt: number }>();
  for (const r of master) {
    if (!drivers.has(r.personId)) continue;
    const cur = byCustomer.get(r.customer) ?? { driverRt: 0, driverOt: 0 };
    if (r.transactionCode === "RT") cur.driverRt += r.payUnit ?? 0;
    if (r.transactionCode === "OT") cur.driverOt += r.payUnit ?? 0;
    byCustomer.set(r.customer, cur);
  }

  const adjustments = [...byCustomer]
    .map(([customer, v]) => ({
      customer, driverRt: round2(v.driverRt), driverOt: round2(v.driverOt),
    }))
    .sort((a, b) => a.customer.localeCompare(b.customer));

  return {
    matched: matched.sort((a, b) => a - b),
    expectedUnmatched: expectedUnmatched.sort((a, b) => a.personId - b.personId),
    unexpectedUnmatched: unexpectedUnmatched.sort((a, b) => a - b),
    adjustments,
    totals: {
      driverRt: round2(adjustments.reduce((s, a) => s + a.driverRt, 0)),
      driverOt: round2(adjustments.reduce((s, a) => s + a.driverOt, 0)),
    },
  };
}

/**
 * Does the planned removal agree with the driver worksheet?
 *
 * The instructions tie the adjustment columns to the driver pivot before
 * anything is deleted. Same check, stated as a comparison rather than two snips
 * held side by side.
 */
export function checkDriverAdjustmentsTie(
  plan: DriverRemovalPlan, worksheetRt: number, worksheetOt: number,
): { ok: boolean; message: string } {
  const dRt = round2(plan.totals.driverRt - worksheetRt);
  const dOt = round2(plan.totals.driverOt - worksheetOt);
  const ok = Math.abs(dRt) < 0.005 && Math.abs(dOt) < 0.005;
  return {
    ok,
    message: ok
      ? `driver hours tie — RT ${plan.totals.driverRt}, OT ${plan.totals.driverOt}`
      : `driver hours DO NOT tie — plan RT ${plan.totals.driverRt} vs worksheet ${worksheetRt} (${dRt}), plan OT ${plan.totals.driverOt} vs worksheet ${worksheetOt} (${dOt})`,
  };
}

/**
 * ⚠️ The master export's last three headers carry LEADING SPACES.
 *
 * `" End Date"`, `" Status"` and `" Assignment Id"` are the real column names
 * as Zenople emits them, and the import expects them back unchanged. Trimming
 * them on write produces a file that looks right and will not load.
 */
export const MASTER_HEADERS: readonly string[] = [
  "Customer", "Person", "SSN", "JobId", "PersonId", "TransactionCode",
  "Pay Unit", "Pay Rate", "Bill Unit", "Bill Rate", "Item Pay", "Item Bill",
  "PPE", "Start Date", " End Date", " Status", " Assignment Id",
];

/** Guard for anything that writes the master back out. */
export function assertMasterHeaders(headers: string[]): void {
  const mismatch = MASTER_HEADERS.filter((h, i) => headers[i] !== h);
  if (mismatch.length) {
    throw new Error(
      `master headers do not match Zenople's exactly (leading spaces matter): ` +
      mismatch.map((h) => JSON.stringify(h)).join(", "),
    );
  }
}
