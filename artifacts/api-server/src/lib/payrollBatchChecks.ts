/**
 * Wednesday's review of the payroll register, before anything is paid.
 *
 * These are the last checks with a human still in front of them. After this the
 * batch closes, the bank file goes out, and a wrong number is a wrong payment
 * rather than a wrong spreadsheet.
 */

/** A row of the payroll register, narrowed to what these checks need. */
export type RegisterRow = {
  PersonId?: number | null;
  Name?: string | null;
  CheckNumber?: string | null;
  CheckDate?: string | null;
  Gross?: number | null;
  Net?: number | null;
  Tax?: number | null;
  Deduction?: number | null;
  Reimbursement?: number | null;
  Advance?: number | null;
  IsLiveCheck?: boolean | null;
  CheckStatus?: string | null;
  TotalPayHours?: number | null;
  PaymentBatchId?: number | null;
};

export type BatchCheck = {
  check: string;
  status: "pass" | "fail" | "warn" | "info";
  message: string;
  detail: unknown[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * ⚠️ Outlier bounds, straight from the checklist: "Review outliers (payments
 * under under 300 or over 2000)".
 *
 * These are NOT errors — a part week is legitimately under 300 and a heavy
 * overtime week is legitimately over 2000. They are the rows a human should
 * look at, so this reports `warn` and never blocks.
 */
export const OUTLIER_LOW = 300;
export const OUTLIER_HIGH = 2000;

export function checkOutliers(rows: RegisterRow[]): BatchCheck {
  const out = rows
    .filter((r) => {
      const net = r.Net ?? 0;
      return net > 0 && (net < OUTLIER_LOW || net > OUTLIER_HIGH);
    })
    .map((r) => ({
      personId: r.PersonId, name: r.Name, net: round2(r.Net ?? 0),
      hours: r.TotalPayHours ?? 0,
      side: (r.Net ?? 0) < OUTLIER_LOW ? "under" : "over",
    }))
    .sort((a, b) => a.net - b.net);

  return {
    check: "outliers",
    status: out.length ? "warn" : "pass",
    message: out.length
      ? `${out.length} payment${out.length === 1 ? "" : "s"} outside ${OUTLIER_LOW}-${OUTLIER_HIGH} — look, do not assume`
      : `every payment between ${OUTLIER_LOW} and ${OUTLIER_HIGH}`,
    detail: out,
  };
}

/**
 * Live checks — anyone not being paid by ACH.
 *
 * The checklist asks "Check to see if any live checks" because a live check is
 * a physical thing somebody has to produce and hand over, and finding out on
 * Friday is too late.
 */
export function checkLiveChecks(rows: RegisterRow[]): BatchCheck {
  const live = rows.filter((r) => r.IsLiveCheck === true)
    .map((r) => ({ personId: r.PersonId, name: r.Name, net: round2(r.Net ?? 0),
                   checkNumber: r.CheckNumber }));
  return {
    check: "live_checks",
    status: live.length ? "info" : "pass",
    message: live.length
      ? `${live.length} live check${live.length === 1 ? "" : "s"} to produce`
      : "no live checks — everything is ACH",
    detail: live,
  };
}

/**
 * Voided and reversed checks in the run.
 *
 * A check number carrying V or R is a void or a reversal. They are legitimate
 * but they distort every total taken off this register, and Holiday Pay
 * eligibility counts check dates — so they are surfaced rather than left to be
 * discovered downstream.
 */
export function checkVoidsAndReversals(rows: RegisterRow[]): BatchCheck {
  const flagged = rows.filter((r) => /[VR]/i.test(String(r.CheckNumber ?? "")) &&
                                     /[a-z]/i.test(String(r.CheckNumber ?? "")))
    .map((r) => ({ personId: r.PersonId, name: r.Name,
                   checkNumber: r.CheckNumber, status: r.CheckStatus }));
  return {
    check: "voids_and_reversals",
    status: flagged.length ? "warn" : "pass",
    message: flagged.length
      ? `${flagged.length} void or reversal in this run — they distort totals and check-date counts`
      : "no voids or reversals",
    detail: flagged,
  };
}

/**
 * Gross must reconcile to net for every person.
 *
 * net = gross + reimbursement − tax − deduction − advance. A row that does not
 * balance means a component was missed, and it is far easier to find here than
 * in a batch total.
 */
export function checkGrossToNet(rows: RegisterRow[]): BatchCheck {
  const off = rows
    .map((r) => {
      const expected = round2((r.Gross ?? 0) + (r.Reimbursement ?? 0)
        - (r.Tax ?? 0) - (r.Deduction ?? 0) - (r.Advance ?? 0));
      const diff = round2(expected - (r.Net ?? 0));
      return { personId: r.PersonId, name: r.Name, expected, net: round2(r.Net ?? 0), diff };
    })
    .filter((x) => Math.abs(x.diff) > 0.004);

  return {
    check: "gross_to_net",
    status: off.length ? "fail" : "pass",
    message: off.length
      ? `${off.length} payment${off.length === 1 ? "" : "s"} do not reconcile gross to net`
      : "every payment reconciles gross to net",
    detail: off.slice(0, 25),
  };
}

/**
 * ⚠️ Nobody should be paid with no tax withheld.
 *
 * The checklist singles out Pennsylvania — its local withholding is the one
 * that goes wrong — but a zero-tax row anywhere is worth a look, so this checks
 * everyone and lets the caller mark which people are in PA.
 *
 * ⚠️ A known and legitimate exception exists: Yvon Agustin, a Wisconsin
 * resident whose Kentucky code is not taxable. Exceptions are passed in by
 * PersonId so a real new zero-tax row still shows.
 */
export function checkTaxWithheld(
  rows: RegisterRow[],
  opts: { paPersonIds?: ReadonlySet<number>; knownExempt?: ReadonlySet<number> } = {},
): BatchCheck {
  const exempt = opts.knownExempt ?? new Set<number>();
  const pa = opts.paPersonIds ?? new Set<number>();

  const zero = rows
    .filter((r) => (r.Gross ?? 0) > 0 && (r.Tax ?? 0) === 0)
    .filter((r) => !exempt.has(r.PersonId ?? -1))
    .map((r) => ({
      personId: r.PersonId, name: r.Name, gross: round2(r.Gross ?? 0),
      pennsylvania: pa.has(r.PersonId ?? -1),
    }));

  const paZero = zero.filter((z) => z.pennsylvania).length;
  return {
    check: "tax_withheld",
    status: zero.length ? "warn" : "pass",
    message: zero.length
      ? `${zero.length} paid with no tax withheld${paZero ? `, ${paZero} of them in Pennsylvania` : ""}`
      : "every paid person had tax withheld",
    detail: zero,
  };
}

/** Totals for the run, for the eyeball comparison against last week. */
export function batchTotals(rows: RegisterRow[]): BatchCheck {
  const sum = (f: (r: RegisterRow) => number) => round2(rows.reduce((s, r) => s + f(r), 0));
  const totals = {
    payments: rows.length,
    gross: sum((r) => r.Gross ?? 0),
    tax: sum((r) => r.Tax ?? 0),
    deduction: sum((r) => r.Deduction ?? 0),
    net: sum((r) => r.Net ?? 0),
    hours: sum((r) => r.TotalPayHours ?? 0),
    batches: [...new Set(rows.map((r) => r.PaymentBatchId).filter((b) => b != null))],
  };
  return {
    check: "batch_totals",
    status: "info",
    message: `${totals.payments} payments · gross ${totals.gross} · net ${totals.net} · ${totals.hours} hours`,
    detail: [totals],
  };
}

/**
 * ⚠️ More than one payment batch in a single check date.
 *
 * Legitimate on an accelerated holiday week, and a mistake otherwise — the
 * reference week PD 08.28.2026 is one batch (919), while PD 08.21.2026 carried
 * three. Worth stating either way rather than discovering it in the bank file.
 */
export function checkSingleBatch(rows: RegisterRow[]): BatchCheck {
  const batches = [...new Set(rows.map((r) => r.PaymentBatchId).filter((b) => b != null))];
  return {
    check: "single_batch",
    status: batches.length > 1 ? "warn" : "pass",
    message: batches.length > 1
      ? `${batches.length} payment batches in this run (${batches.join(", ")}) — expected on an accelerated week, otherwise check`
      : `one payment batch (${batches[0] ?? "none"})`,
    detail: batches.length > 1 ? [{ batches }] : [],
  };
}

/** Everything Wednesday needs, in one call. */
export function runBatchChecks(
  rows: RegisterRow[],
  opts: { paPersonIds?: ReadonlySet<number>; knownExempt?: ReadonlySet<number> } = {},
): BatchCheck[] {
  return [
    batchTotals(rows),
    checkSingleBatch(rows),
    checkGrossToNet(rows),
    checkOutliers(rows),
    checkLiveChecks(rows),
    checkVoidsAndReversals(rows),
    checkTaxWithheld(rows, opts),
  ];
}
