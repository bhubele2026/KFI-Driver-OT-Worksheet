/**
 * The six tie-outs.
 *
 * These are the actual work of the payroll week. They recur from Monday to
 * Thursday, they are what catches a wrong number before it becomes a wrong
 * paycheck, and today they are done by pasting pivot snips into a workbook.
 * Here they are pure functions over transaction rows so they can be re-run
 * cheaply, rendered pass/fail, and — importantly — tested for the ability to
 * FAIL, which a pasted screenshot cannot be.
 *
 * Numbers are compared in integer cents. Floating-point sums of money drift,
 * and tie-out #4 has to be EXACT.
 */

/** A Zenople transaction item, narrowed to the fields the tie-outs need. */
export type TxItem = {
  AccountingPeriod?: string | null;
  Organization?: string | null;
  Person?: string | null;
  PersonId?: number | null;
  TransactionCode?: string | null;
  PayUnit?: number | null;
  BillUnit?: number | null;
  ItemPay?: number | null;
  ItemBill?: number | null;
  RTPayHours?: number | null;
  OTPayHours?: number | null;
  AssignmentId?: number | null;
};

export type TieOutKey =
  | "pay_vs_bill_units"
  | "master_vs_batch"
  | "ot_without_40"
  | "fringe_vs_deductions"
  | "retro_fringe_vs_offset"
  | "tax_vs_register";

export type TieOutResult = {
  tieOut: TieOutKey;
  status: "pass" | "fail";
  scope: string | null;
  expected: string;
  actual: string;
  variance: string;
  /** The rows that caused a failure — "these four people", not "it is off". */
  detail: unknown[];
};

const cents = (n: number | null | undefined): number => Math.round((n ?? 0) * 100);
const money = (c: number): string => (c / 100).toFixed(2);
const units = (n: number): string => n.toFixed(2);

/**
 * Hour codes grouped by what they mean for the 40-hour week and for billing.
 *
 * ⚠️ MEASURED, NOT ASSUMED. Against the real reference week (AP 2026-08-23):
 *
 *  - All 13 people who looked like "OT without 40 regular hours" carried
 *    RT + DriverRT == **exactly 40.00**. Driver-time removal moves hours off RT
 *    onto DriverRT, so RT alone always dips under 40 for a driver. Judging on
 *    RT alone produced 13 false alarms in one week — enough to make the tile
 *    worthless. DriverRT counts toward the 40-hour basis.
 *
 *  - Pay and bill live on **SEPARATE ROWS**: one row carries `RT pay=0 bill=40`
 *    and another `RT pay=32.37 bill=0` for the same person. Any row-wise
 *    comparison of pay units to bill units is meaningless; it must aggregate
 *    per person first.
 *
 *  - Folding driver time back in, regular hours tie for **583 of 606** people.
 *    The residual is DriverOT, which is paid but largely NOT billed — KFI
 *    absorbs driver overtime. So the SOP's "pay units == bill units" is a
 *    REGULAR-HOURS identity. Comparing OT would fail every driver, every week.
 */
export const REGULAR_PAY_CODES = new Set(["RT", "DriverRT", "RetroDriverRT"]);
export const OT_PAY_CODES = new Set(["OT", "DriverOT", "RetroDriverOT"]);
/** Hours that count toward the 40-hour threshold. */
export const BASE_HOURS_CODES = new Set(["RT", "DriverRT", "DT"]);

/**
 * Codes that are paid but never billed, so they can never appear in a
 * pay-vs-bill comparison. Lump sums put the quantity in Pay Unit and the
 * DOLLARS in Pay Rate, with every bill column 0.
 */
export const NON_BILLED_CODES = new Set([
  "Housing Benefit Supplemental", "Retro Housing Benefit Sup",
  "MN ESST", "Referral Bonus", "Cell Reimburse", "Advance",
  "ACH Reimbursement", "Expense Reimbursement", "RefundHousing",
  "RefundTransportation", "Health Ins Stipend", "ICHRAReimbursement",
  "Severance Pay", "Job Transfer Premium - Reg", "Job Transfer Premium - OT",
]);

/**
 * 1 — Regular pay hours == regular bill hours, per person.
 *
 * Reported per person rather than per customer because the answer a processor
 * needs is "who", and because legitimate exceptions exist: some associates are
 * genuinely non-billable (the Shusters crew leads, confirmed by Client Success
 * on 2026-08-26). Those are passed in as `nonBillablePersonIds` so a known
 * exception stops being an alarm without hiding a new one.
 */
export function tieOutPayVsBillUnits(
  items: TxItem[],
  nonBillablePersonIds: ReadonlySet<number> = new Set(),
): TieOutResult[] {
  const per = new Map<number, { name: string; org: string; pay: number; bill: number }>();
  for (const it of items) {
    const code = it.TransactionCode ?? "";
    if (!REGULAR_PAY_CODES.has(code)) continue;
    const id = it.PersonId ?? -1;
    const cur = per.get(id) ?? {
      name: it.Person ?? String(id), org: it.Organization ?? "(unknown)", pay: 0, bill: 0,
    };
    cur.pay += it.PayUnit ?? 0;
    cur.bill += it.BillUnit ?? 0;
    per.set(id, cur);
  }

  const byCustomer = new Map<string, { pay: number; bill: number; off: unknown[] }>();
  for (const [personId, v] of per) {
    const c = byCustomer.get(v.org) ?? { pay: 0, bill: 0, off: [] };
    c.pay += v.pay;
    c.bill += v.bill;
    if (Math.abs(v.pay - v.bill) > 0.004 && !nonBillablePersonIds.has(personId)) {
      c.off.push({
        personId, person: v.name,
        payHours: +v.pay.toFixed(2), billHours: +v.bill.toFixed(2),
        variance: +(v.pay - v.bill).toFixed(2),
      });
    }
    byCustomer.set(v.org, c);
  }

  const out: TieOutResult[] = [];
  let payAll = 0;
  let billAll = 0;
  for (const [customer, c] of [...byCustomer].sort((a, b) => a[0].localeCompare(b[0]))) {
    payAll += c.pay;
    billAll += c.bill;
    out.push({
      tieOut: "pay_vs_bill_units",
      status: c.off.length ? "fail" : "pass",
      scope: customer,
      expected: units(c.pay),
      actual: units(c.bill),
      variance: units(c.pay - c.bill),
      detail: c.off,
    });
  }
  const totalOff = out.reduce((s, r) => s + r.detail.length, 0);
  out.push({
    tieOut: "pay_vs_bill_units",
    status: totalOff ? "fail" : "pass",
    scope: null,
    expected: units(payAll),
    actual: units(billAll),
    variance: units(payAll - billAll),
    detail: [],
  });
  return out;
}

/**
 * 3 — Nobody carries OT without 40 base hours, and nobody exceeds 40 base.
 *
 * "Base" is RT + DriverRT + DT, not RT alone — see the note above. Aggregated
 * per person, because one person can hold rows on several assignments and
 * 20 + 20 across two assignments is a legitimate 40, not two violations.
 */
export function tieOutOtWithout40(items: TxItem[]): TieOutResult {
  const per = new Map<number, { name: string; base: number; ot: number }>();
  for (const it of items) {
    const code = it.TransactionCode ?? "";
    const isBase = BASE_HOURS_CODES.has(code);
    const isOt = OT_PAY_CODES.has(code);
    if (!isBase && !isOt) continue;
    const id = it.PersonId ?? -1;
    const cur = per.get(id) ?? { name: it.Person ?? String(id), base: 0, ot: 0 };
    if (isBase) cur.base += it.PayUnit ?? 0;
    else cur.ot += it.PayUnit ?? 0;
    per.set(id, cur);
  }

  const bad: unknown[] = [];
  for (const [personId, v] of per) {
    if (v.ot > 0.004 && v.base < 39.996) {
      bad.push({ personId, person: v.name, reason: "OT without 40 base hours",
                 base: +v.base.toFixed(2), ot: +v.ot.toFixed(2) });
    }
    if (v.base > 40.004) {
      bad.push({ personId, person: v.name, reason: "base hours over 40",
                 base: +v.base.toFixed(2), ot: +v.ot.toFixed(2) });
    }
  }

  return {
    tieOut: "ot_without_40",
    status: bad.length ? "fail" : "pass",
    scope: null,
    expected: "0 exceptions",
    actual: `${bad.length} exception${bad.length === 1 ? "" : "s"}`,
    variance: String(bad.length),
    detail: bad,
  };
}

/**
 * 4 — Housing Benefit Supplemental earnings == TBD3 fringe deductions, EXACTLY.
 *
 * The workbook carries this live (722.71 = 722.71) with the sign convention
 * spelled out: positive means missing deductions, negative means missing
 * earnings. That convention is preserved here because it is how the person
 * fixing it knows which side to go look at.
 */
export function tieOutFringeVsDeductions(
  items: TxItem[],
  deductionTotal: number,
): TieOutResult {
  const rows = items.filter((i) => i.TransactionCode === "Housing Benefit Supplemental");
  const earn = rows.reduce((s, r) => s + cents(r.ItemPay), 0);
  const ded = cents(deductionTotal);
  const diff = earn - ded;
  return {
    tieOut: "fringe_vs_deductions",
    status: diff === 0 ? "pass" : "fail",
    scope: null,
    expected: money(earn),
    actual: money(ded),
    variance: `${diff > 0 ? "+" : ""}${money(diff)}`,
    detail:
      diff === 0
        ? []
        : [{
            hint: diff > 0
              ? "positive — missing deductions"
              : "negative — missing earnings",
            earningsRows: rows.length,
          }],
  };
}

/** 5 — Retro Housing Benefit Sup == Retro Housing Benefits Offset Supplemental. */
export function tieOutRetroFringeVsOffset(
  items: TxItem[],
  offsetTotal: number,
): TieOutResult {
  const earn = items
    .filter((i) => i.TransactionCode === "Retro Housing Benefit Sup")
    .reduce((s, r) => s + cents(r.ItemPay), 0);
  const off = cents(offsetTotal);
  const diff = earn - off;
  return {
    tieOut: "retro_fringe_vs_offset",
    status: diff === 0 ? "pass" : "fail",
    scope: null,
    expected: money(earn),
    actual: money(off),
    variance: `${diff > 0 ? "+" : ""}${money(diff)}`,
    detail: [],
  };
}

/**
 * 2 — The assembled master agrees with what Zenople actually holds.
 *
 * Compared on RT and OT hours per customer, which is what the Timesheet
 * processing tab and the transaction batch report both key on.
 */
export function tieOutMasterVsBatch(
  master: TxItem[],
  zenople: TxItem[],
): TieOutResult[] {
  const sum = (rows: TxItem[]) => {
    const m = new Map<string, { rt: number; ot: number }>();
    for (const r of rows) {
      const code = r.TransactionCode ?? "";
      if (code !== "RT" && code !== "OT") continue;
      const k = r.Organization ?? "(unknown)";
      const cur = m.get(k) ?? { rt: 0, ot: 0 };
      if (code === "RT") cur.rt += r.PayUnit ?? 0;
      else cur.ot += r.PayUnit ?? 0;
      m.set(k, cur);
    }
    return m;
  };
  const a = sum(master);
  const b = sum(zenople);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();

  return keys.map((k) => {
    const x = a.get(k) ?? { rt: 0, ot: 0 };
    const y = b.get(k) ?? { rt: 0, ot: 0 };
    const dRt = x.rt - y.rt;
    const dOt = x.ot - y.ot;
    const off = Math.abs(dRt) > 0.004 || Math.abs(dOt) > 0.004;
    return {
      tieOut: "master_vs_batch" as const,
      status: off ? ("fail" as const) : ("pass" as const),
      scope: k,
      expected: `RT ${units(x.rt)} / OT ${units(x.ot)}`,
      actual: `RT ${units(y.rt)} / OT ${units(y.ot)}`,
      variance: `RT ${units(dRt)} / OT ${units(dOt)}`,
      detail: off ? [{ customer: k, masterRt: x.rt, masterOt: x.ot, zenopleRt: y.rt, zenopleOt: y.ot }] : [],
    };
  });
}

/** 6 — Daily Tax pivot == Payroll Register == APTM upload. */
export function tieOutTaxVsRegister(
  taxTotal: number,
  registerTotal: number,
  aptmTotal: number | null,
): TieOutResult {
  const t = cents(taxTotal);
  const r = cents(registerTotal);
  const a = aptmTotal == null ? null : cents(aptmTotal);
  const legs = a == null ? [t === r] : [t === r, r === a];
  const ok = legs.every(Boolean);
  return {
    tieOut: "tax_vs_register",
    status: ok ? "pass" : "fail",
    scope: null,
    expected: money(r),
    actual: a == null ? money(t) : `tax ${money(t)} / aptm ${money(a)}`,
    variance: money(t - r),
    detail: ok ? [] : [{ taxPivot: money(t), register: money(r), aptm: a == null ? null : money(a) }],
  };
}
