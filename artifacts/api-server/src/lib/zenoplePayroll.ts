import { pull } from "./zenopleClient.js";
import { periodDatesFor } from "./payrollPeriod.js";
import {
  tieOutPayVsBillUnits, tieOutOtWithout40, tieOutFringeVsDeductions,
  tieOutRetroFringeVsOffset, type TieOutResult, type TxItem,
} from "./payrollTieOuts.js";

/**
 * Pulling one pay period out of Zenople, and tying it out.
 *
 * ⚠️ THE WINDOW FILTERS ON LAST-MODIFIED, NOT ON THE PAY PERIOD. Every action
 * here takes a UTC window that means "rows touched in this range", so a period
 * is selected by pulling a generous recent window and filtering locally on
 * `AccountingPeriod`. Asking for a narrow window around the pay date returns
 * the wrong set, not a smaller one.
 */

/** Deduction rows, narrowed to what the fringe tie-outs need. */
type DeductionRow = {
  AccountingPeriod?: string | null;
  TransactionCode?: string | null;
  /** ⚠️ The real weekly amount. `Deduction` is a DIFFERENT number — on the
   *  reference week Adjustment summed to 722.71 (correct) and Deduction to
   *  2589.37. Never reconcile on `Deduction`. */
  Adjustment?: number | null;
  Deduction?: number | null;
  PaymentAdjustmentId?: number | null;
  PersonId?: number | null;
  Name?: string | null;
};

/**
 * The deduction that offsets the housing fringe earning.
 *
 * The SOP calls this "TBD3 Fringe"; in the data it is
 * `Housing Benefit Offset Supplemental`. Confirmed against the reference week:
 * 25 earning rows summing 722.71 and 25 deduction rows summing 722.71, which is
 * the exact figure carried live in the changes workbook.
 */
export const FRINGE_OFFSET_CODE = "Housing Benefit Offset Supplemental";
export const RETRO_FRINGE_OFFSET_CODE = "Retro Housing Benefits Offset Supplemental";

/** How far back to look for rows belonging to a period. */
const DEFAULT_LOOKBACK_DAYS = 30;

const apOf = (r: { AccountingPeriod?: string | null }): string =>
  (r.AccountingPeriod ?? "").slice(0, 10);

/**
 * Sum a deduction code for one accounting period.
 *
 * ⚠️ Deduped on `PaymentAdjustmentId` — the endpoint can repeat a row, and a
 * duplicated offset silently breaks a tie-out that has to be exact.
 */
export function sumDeduction(
  rows: DeductionRow[],
  accountingPeriod: string,
  code: string,
): number {
  const seen = new Set<number>();
  let total = 0;
  for (const r of rows) {
    if (apOf(r) !== accountingPeriod || r.TransactionCode !== code) continue;
    const id = r.PaymentAdjustmentId ?? null;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    total += r.Adjustment ?? 0;
  }
  return total;
}

export type PeriodPull = {
  payDate: string;
  accountingPeriod: string;
  items: TxItem[];
  deductions: DeductionRow[];
};

/** Everything one period needs, in two calls rather than per-customer chatter. */
export async function pullPeriod(
  payDate: string,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): Promise<PeriodPull> {
  const { accountingPeriod } = periodDatesFor(payDate);
  const [items, deductions] = await Promise.all([
    pull<TxItem>("TransactionItemData", { lookbackDays }),
    pull<DeductionRow>("DeductionData", { lookbackDays }),
  ]);
  return {
    payDate,
    accountingPeriod,
    items: items.filter((r) => apOf(r) === accountingPeriod),
    deductions: deductions.filter((r) => apOf(r) === accountingPeriod),
  };
}

/**
 * Run every tie-out that can be computed from Zenople alone.
 *
 * Tie-out 2 (master vs batch) needs the assembled master file and tie-out 6
 * needs the tax pivot and APTM upload, so neither is here — they belong to the
 * tiles that hold those artifacts.
 */
export function runTieOuts(
  pulled: PeriodPull,
  nonBillablePersonIds: ReadonlySet<number> = new Set(),
): TieOutResult[] {
  const fringeDeductions = sumDeduction(
    pulled.deductions, pulled.accountingPeriod, FRINGE_OFFSET_CODE);
  const retroDeductions = sumDeduction(
    pulled.deductions, pulled.accountingPeriod, RETRO_FRINGE_OFFSET_CODE);

  return [
    ...tieOutPayVsBillUnits(pulled.items, nonBillablePersonIds),
    tieOutOtWithout40(pulled.items),
    tieOutFringeVsDeductions(pulled.items, fringeDeductions),
    tieOutRetroFringeVsOffset(pulled.items, retroDeductions),
  ];
}

/** The customer roster as Zenople actually spells it, for this period. */
export function rosterFrom(pulled: PeriodPull): string[] {
  return [...new Set(pulled.items.map((i) => i.Organization ?? "").filter(Boolean))].sort();
}
