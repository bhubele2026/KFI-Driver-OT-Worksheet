import { addDays } from "./time.js";

/**
 * Expert Pay — the child-support disbursement, Thursday or Friday.
 *
 * ⚠️ THE FILE NEVER COMES INTO THIS APP. `Expert Pay/CS Expert Pay PD <d>.csv`
 * carries UNMASKED nine-digit SSNs; everything else in the payroll tree is
 * masked `XXX-XX-nnnn`. This module works on totals and dates a person types or
 * the bridge reports — never on the file's rows. The artifact classifier marks
 * anything Expert Pay as sensitive from both directions for the same reason.
 *
 * ⚠️ THE PAYMENT STAYS MANUAL. This prepares and checks; a human logs in,
 * confirms the bank account, and clicks Submit. Nothing here moves money.
 */

/** ⚠️ Child support is drawn from Bank 7, not the operating account. */
export const EXPERT_PAY_BANK = "Bank 7";

export type ExpertPayDates = {
  /** The payroll check date. */
  payDate: string;
  /** ⚠️ The Tuesday AFTER the pay date. Not the pay date, not the next day. */
  effectiveDate: string;
  /** ⚠️ The paycheck date itself — deliberately different from effective. */
  withholdingDate: string;
};

/**
 * The two dates Expert Pay asks for, which are NOT the same.
 *
 * Effective is the Tuesday after the pay date; withholding is the paycheck
 * date. Entering the pay date in both is the obvious slip, and it dates the
 * disbursement wrongly against a court order.
 */
export function expertPayDates(payDate: string): ExpertPayDates {
  const dow = new Date(`${payDate}T00:00:00Z`).getUTCDay(); // 0=Sun … 2=Tue
  // Strictly AFTER the pay date, so a Tuesday pay date rolls a full week.
  const delta = ((2 - dow + 7) % 7) || 7;
  return {
    payDate,
    effectiveDate: addDays(payDate, delta),
    withholdingDate: payDate,
  };
}

export type ExpertPayCheck = {
  check: string;
  status: "pass" | "fail" | "warn" | "info";
  message: string;
  detail: unknown[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The formatting steps, as blocking gates.
 *
 * Each is here because skipping it corrupts the file rather than erroring:
 * a converted open strips leading zeros off SSNs, and a decimal left in
 * column C changes every amount.
 */
export type ExpertPayFormat = {
  /** ⚠️ Answer NO to the convert prompt. Converting strips leading zeros off
   *  the SSNs in column E and you then have to repair them by hand. */
  openedWithoutConverting: boolean;
  /** Column C to number format with 0 decimals. */
  columnCZeroDecimals: boolean;
  /** Column E SSNs — any leading zeros restored as text. */
  ssnLeadingZerosIntact: boolean;
  /** ⚠️ Saved after formatting. Forgetting this produces an upload error. */
  savedAfterFormatting: boolean;
};

export function checkExpertPayFormat(f: ExpertPayFormat): ExpertPayCheck {
  const missing: string[] = [];
  if (!f.openedWithoutConverting) {
    missing.push("re-open WITHOUT converting — converting strips leading zeros from the SSNs");
  }
  if (!f.columnCZeroDecimals) missing.push("column C to number format, 0 decimals");
  if (!f.ssnLeadingZerosIntact) missing.push("restore leading zeros in column E as text");
  if (!f.savedAfterFormatting) {
    missing.push("SAVE the file — an unsaved change is the usual cause of the upload error");
  }
  return {
    check: "expert_pay_format",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? `${missing.length} formatting step${missing.length === 1 ? "" : "s"} outstanding`
      : "file is formatted correctly",
    detail: missing,
  };
}

/**
 * The totals comparison, allowing for fees.
 *
 * ⚠️ "We pay fees so the total payments will be slightly more than the file."
 * The system total is EXPECTED to exceed the CSV total — so an exact-match
 * check would fail every week and a blind pass would hide a real difference.
 * This asserts the system is at least the file total and no more than a
 * plausible fee above it.
 */
export const MAX_FEE_FRACTION = 0.05;

export function checkExpertPayTotals(
  csvTotal: number, systemTotal: number,
): ExpertPayCheck {
  const diff = round2(systemTotal - csvTotal);
  const maxFee = round2(Math.max(csvTotal * MAX_FEE_FRACTION, 5));

  if (diff < -0.004) {
    return {
      check: "expert_pay_totals",
      status: "fail",
      message: `the system total ${round2(systemTotal)} is LESS than the file ${round2(csvTotal)} — payments are missing`,
      detail: [{ csvTotal: round2(csvTotal), systemTotal: round2(systemTotal), diff }],
    };
  }
  if (diff > maxFee) {
    return {
      check: "expert_pay_totals",
      status: "fail",
      message: `the system total exceeds the file by ${diff}, more than a plausible fee (up to ${maxFee})`,
      detail: [{ csvTotal: round2(csvTotal), systemTotal: round2(systemTotal), diff, maxFee }],
    };
  }
  return {
    check: "expert_pay_totals",
    status: "pass",
    message: diff === 0
      ? `totals match exactly at ${round2(csvTotal)}`
      : `system ${round2(systemTotal)} vs file ${round2(csvTotal)} — ${diff} of fees, as expected`,
    detail: [],
  };
}

/** The bank account, which is not the one everything else uses. */
export function checkBankAccount(selected: string): ExpertPayCheck {
  const ok = selected.trim().toLowerCase() === EXPERT_PAY_BANK.toLowerCase();
  return {
    check: "expert_pay_bank",
    status: ok ? "pass" : "fail",
    message: ok
      ? `bank account is ${EXPERT_PAY_BANK}`
      : `bank account is "${selected}" — child support draws from ${EXPERT_PAY_BANK}`,
    detail: ok ? [] : [{ selected, required: EXPERT_PAY_BANK }],
  };
}

/** The two dates, checked against what was typed in. */
export function checkExpertPayDates(
  payDate: string, enteredEffective: string, enteredWithholding: string,
): ExpertPayCheck {
  const want = expertPayDates(payDate);
  const problems: unknown[] = [];
  if (enteredEffective !== want.effectiveDate) {
    problems.push({ field: "effective date", entered: enteredEffective,
                    expected: want.effectiveDate, rule: "the Tuesday after the pay date" });
  }
  if (enteredWithholding !== want.withholdingDate) {
    problems.push({ field: "withholding date", entered: enteredWithholding,
                    expected: want.withholdingDate, rule: "the paycheck date itself" });
  }
  return {
    check: "expert_pay_dates",
    status: problems.length ? "fail" : "pass",
    message: problems.length
      ? `${problems.length} date${problems.length === 1 ? " is" : "s are"} wrong — these two are NOT the same date`
      : `effective ${want.effectiveDate}, withholding ${want.withholdingDate}`,
    detail: problems,
  };
}

/** What must be filed afterwards, per the SOP's closing steps. */
export const EXPERT_PAY_ARTIFACTS = [
  "payment confirmation (printed to PDF)",
  "payment detail with employee names (from Payment history)",
] as const;

/** The export's Note field, which is how the run is identified in Zenople. */
export function expertPayExportNote(payDate: string): string {
  const [y, m, d] = payDate.split("-");
  return `CS PD ${m}.${d}.${y}`;
}

export function runExpertPayChecks(input: {
  payDate: string;
  enteredEffective?: string;
  enteredWithholding?: string;
  bankAccount?: string;
  format?: ExpertPayFormat;
  csvTotal?: number;
  systemTotal?: number;
}): ExpertPayCheck[] {
  const out: ExpertPayCheck[] = [{
    check: "export_note",
    status: "info",
    message: `Zenople export note: ${expertPayExportNote(input.payDate)}`,
    detail: [],
  }];
  if (input.format) out.push(checkExpertPayFormat(input.format));
  if (input.enteredEffective && input.enteredWithholding) {
    out.push(checkExpertPayDates(input.payDate, input.enteredEffective, input.enteredWithholding));
  }
  if (input.bankAccount) out.push(checkBankAccount(input.bankAccount));
  if (input.csvTotal !== undefined && input.systemTotal !== undefined) {
    out.push(checkExpertPayTotals(input.csvTotal, input.systemTotal));
  }
  return out;
}
