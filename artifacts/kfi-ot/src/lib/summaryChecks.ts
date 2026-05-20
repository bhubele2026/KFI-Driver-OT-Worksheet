export interface SummaryTotalsLike {
  driverHours: number | string;
  customerHours: number | string;
  totalHours: number | string;
  regularHours: number | string;
  overtimeHours: number | string;
  driverRt: number | string;
  driverOt: number | string;
  custRt: number | string;
  custOt: number | string;
}

export interface SummaryCheckLabels {
  totalEq: string;
  customerEq: string;
  driverEq: string;
  rtEq: string;
  otEq: string;
  rtPlusOtEq: string;
  rowSumEq: string;
}

export interface SummaryCheck {
  key: string;
  label: string;
  expected: number;
  actual: number;
}

export const CHECK_EPSILON = 0.015;

export function checksEq(a: number, b: number): boolean {
  return Math.abs(a - b) < CHECK_EPSILON;
}

export function buildSummaryChecks(args: {
  totals: SummaryTotalsLike;
  rowHoursSum: number;
  labels: SummaryCheckLabels;
}): SummaryCheck[] {
  const { totals, rowHoursSum, labels } = args;
  const totDriver = Number(totals.driverHours) || 0;
  const totCust = Number(totals.customerHours) || 0;
  const total = Number(totals.totalHours) || 0;
  const rt = Number(totals.regularHours) || 0;
  const ot = Number(totals.overtimeHours) || 0;
  const driverRt = Number(totals.driverRt) || 0;
  const driverOt = Number(totals.driverOt) || 0;
  const custRt = Number(totals.custRt) || 0;
  const custOt = Number(totals.custOt) || 0;

  const checkTotal = totDriver + totCust;
  const checkCustomer = total - totDriver;
  const checkDriver = total - totCust;
  const checkRt = custRt + driverRt;
  const checkOt = custOt + driverOt;
  const rtPlusOt = rt + ot;

  return [
    { key: "total-driver-customer", label: labels.totalEq, expected: total, actual: checkTotal },
    { key: "customer-total-driver", label: labels.customerEq, expected: totCust, actual: checkCustomer },
    { key: "driver-total-customer", label: labels.driverEq, expected: totDriver, actual: checkDriver },
    { key: "rt-min-total-40-", label: labels.rtEq, expected: rt, actual: checkRt },
    { key: "ot-max-0-total-40-", label: labels.otEq, expected: ot, actual: checkOt },
    { key: "rt-ot-total", label: labels.rtPlusOtEq, expected: total, actual: rtPlusOt },
    // Compares the Summary's "Total Hours" against the last value shown in
    // the punch table's "Running" column — i.e. the number a dispatcher
    // sees at the bottom of the table. Caller passes that final running
    // value directly so the check reflects what's on screen, not a
    // re-derived sum.
    { key: "total-row-sum", label: labels.rowSumEq, expected: total, actual: rowHoursSum },
  ];
}

export function sumPunchHours(punches: ReadonlyArray<{ hours: number | string }>): number {
  let s = 0;
  for (const p of punches) s += Number(p.hours) || 0;
  return s;
}
