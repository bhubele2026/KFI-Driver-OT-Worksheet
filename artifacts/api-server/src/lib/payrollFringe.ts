import { proRate } from "./payrollProRate.js";

/**
 * Building and reconciling the fringe import.
 *
 * Fringe is where the week goes wrong quietly. The earnings and the offsetting
 * deductions have to match to the cent (tie-out 4), and the ways they drift are
 * all small: someone with no hours still carrying a housing benefit, a rent
 * pro-rated without its fringe, a deduction that stopped while the assignment
 * stayed open.
 */

/** The codes that make up the fringe file. */
export const FRINGE_CODES = ["Housing Benefit Supplemental", "Cell Reimburse"] as const;
export const RETRO_FRINGE_CODE = "Retro Housing Benefit Sup";

export type FringeRow = {
  personId: number;
  person: string;
  customer: string;
  transactionCode: string;
  /** Always 1 on a fringe row — the money is in the rate. */
  payUnit: number;
  payRate: number;
};

export type MasterExportRow = {
  personId: number;
  person: string;
  customer: string;
  transactionCode: string;
  payUnit: number | null;
  payRate: number | null;
};

/**
 * Pull the fringe rows out of Friday's original export.
 *
 * ⚠️ Source is the ORIGINAL download, not the working master. By Wednesday the
 * working copy has had driver time removed and no-hours people deleted, so
 * building fringe from it would silently drop people who legitimately carry a
 * housing benefit.
 */
export function buildFringeRows(master: MasterExportRow[]): FringeRow[] {
  const codes = new Set<string>([...FRINGE_CODES, RETRO_FRINGE_CODE]);
  return master
    .filter((r) => codes.has(r.transactionCode))
    .map((r) => ({
      personId: r.personId, person: r.person, customer: r.customer,
      transactionCode: r.transactionCode,
      // Pay unit is always 1; the amount lives in the rate.
      payUnit: 1,
      payRate: r.payRate ?? 0,
    }));
}

export type NoHoursDecision = {
  personId: number;
  /**
   * ⚠️ "housed_free" is the exception that matters. When someone has no hours
   * because there was too little work and we are letting them stay in housing
   * free, the fringe does NOT disappear — it moves to next week's file so the
   * housing cost still gets reported. Dropping them loses a real cost.
   */
  reason: "no_work" | "housed_free" | "terminated" | "other";
};

export type NoHoursFringeResult = {
  rows: FringeRow[];
  removed: FringeRow[];
  /** Rows to put on NEXT week's fringe file rather than delete. */
  carryForward: FringeRow[];
};

/** Take the no-hours people out of the fringe file, carrying the free-housed. */
export function removeNoHoursFringe(
  rows: FringeRow[], decisions: NoHoursDecision[],
): NoHoursFringeResult {
  const byId = new Map(decisions.map((d) => [d.personId, d.reason]));
  const kept: FringeRow[] = [];
  const removed: FringeRow[] = [];
  const carryForward: FringeRow[] = [];

  for (const r of rows) {
    const reason = byId.get(r.personId);
    if (reason === undefined) { kept.push(r); continue; }
    if (reason === "housed_free") { carryForward.push(r); removed.push(r); continue; }
    removed.push(r);
  }
  return { rows: kept, removed, carryForward };
}

/**
 * ⚠️ Pro-rate the fringe whenever the housing deduction is pro-rated.
 *
 * The instructions are explicit: "apply the same math to the fringe that you
 * apply to the pro rating of the housing deduction", and separately "make sure
 * when you are processing the payroll and you enter the pro rated housing
 * deduction that you also change the fringe offset deduction". Doing one and
 * not the other is precisely what puts tie-out 4 out of balance.
 */
export type ProRation = { personId: number; days: number };

export function applyFringeProRations(
  rows: FringeRow[], prorations: ProRation[],
): { rows: FringeRow[]; changed: Array<{ personId: number; was: number; now: number; days: number }> } {
  const byId = new Map(prorations.map((p) => [p.personId, p.days]));
  const changed: Array<{ personId: number; was: number; now: number; days: number }> = [];

  const out = rows.map((r) => {
    const days = byId.get(r.personId);
    if (days === undefined || r.transactionCode === "Cell Reimburse") return r;
    const { amount } = proRate({ weeklyAmount: r.payRate, days });
    if (amount !== r.payRate) {
      changed.push({ personId: r.personId, was: r.payRate, now: amount, days });
    }
    return { ...r, payRate: amount };
  });
  return { rows: out, changed };
}

export type FringeReconciliation = {
  /** On the fringe file but with no offsetting deduction — likely remove. */
  earningsWithoutDeduction: FringeRow[];
  /** Holding the deduction but no fringe earning — check it makes sense. */
  deductionsWithoutEarnings: number[];
  matched: number;
};

/**
 * Reconcile fringe earnings against the deduction set-up report.
 *
 * Both directions are reported, because they mean different things. An earning
 * with no deduction has nothing to offset it and comes off the file. A deduction
 * with no earning is usually someone whose retro finished and whose deduction
 * was end-dated while the assignment stayed open — worth a look, rarely an
 * error.
 */
export function reconcileFringeToDeductions(
  rows: FringeRow[], deductionPersonIds: number[], code: string,
): FringeReconciliation {
  const relevant = rows.filter((r) => r.transactionCode === code);
  const withDeduction = new Set(deductionPersonIds);
  const earners = new Set(relevant.map((r) => r.personId));

  return {
    earningsWithoutDeduction: relevant.filter((r) => !withDeduction.has(r.personId)),
    deductionsWithoutEarnings: deductionPersonIds.filter((id) => !earners.has(id)),
    matched: [...earners].filter((id) => withDeduction.has(id)).length,
  };
}

/**
 * The documented out-of-balance hunt, as a function.
 *
 * When the batch report is off, the instructions say to look for a single
 * amount matching the discrepancy — in the deduction report if the deductions
 * are off, in the fringe file if the earnings are. That is a search a person
 * does by scrolling; here it also finds PAIRS, because two rows summing to the
 * gap is the next most common cause and by far the hardest to spot by eye.
 */
export type ImbalanceCandidate = { label: string; amount: number };

export function diagnoseImbalance(
  discrepancy: number, candidates: ImbalanceCandidate[],
): { singles: ImbalanceCandidate[]; pairs: Array<[ImbalanceCandidate, ImbalanceCandidate]> } {
  const cents = (n: number) => Math.round(n * 100);
  const target = Math.abs(cents(discrepancy));

  const singles = candidates.filter((c) => Math.abs(cents(c.amount)) === target);

  const pairs: Array<[ImbalanceCandidate, ImbalanceCandidate]> = [];
  if (target > 0) {
    const seen = new Map<number, ImbalanceCandidate>();
    for (const c of candidates) {
      const v = Math.abs(cents(c.amount));
      const want = target - v;
      const partner = seen.get(want);
      if (partner) pairs.push([partner, c]);
      if (!seen.has(v)) seen.set(v, c);
    }
  }
  return { singles, pairs: pairs.slice(0, 10) };
}

/**
 * ⚠️ MN ESST takes its rate from the person's RT row.
 *
 * From the import instructions: "For MN ESST make sure that you pick the RT row
 * because that is the correct pay rate for their MN ESST". Taking it from a
 * fringe or bonus row pays sick time at the wrong rate.
 */
export function mnEsstRateFor(master: MasterExportRow[], personId: number): number | null {
  const rt = master.find((r) => r.personId === personId && r.transactionCode === "RT");
  return rt?.payRate ?? null;
}

/**
 * Customers absent from the weekly template.
 *
 * Shusters, Bell and Alamco keep time in Zenople, so they have no template row
 * to highlight at this stage and are skipped rather than treated as missing.
 */
export const NOT_ON_TEMPLATE = new Set([
  "Shuster's Building Components", "Bell Lumber", "Alamco Wood Products Inc",
]);
