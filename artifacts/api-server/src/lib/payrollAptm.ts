import { CT_TZ } from "./time.js";

/**
 * The APTM tax upload — Wednesday or Thursday, against a clock.
 *
 * Two things make this different from the rest of the week. It has a hard
 * deadline, and getting it wrong moves money: APTM drafts funds from the file
 * that is uploaded.
 */

/**
 * ⚠️ The upload must be in before 4PM CENTRAL. The instructions open with it,
 * and it is the only step in the week with a cutoff.
 */
export const APTM_DEADLINE_HOUR_CT = 16;

/** The two offices, uploaded and tied out SEPARATELY. */
export const APTM_OFFICES = ["KFIS", "KFISCO"] as const;
export type AptmOffice = (typeof APTM_OFFICES)[number];

export type DeadlineState = {
  deadlineCt: string;
  minutesRemaining: number;
  state: "ok" | "soon" | "past";
};

/**
 * How long is left today, in Central time.
 *
 * Computed in CT explicitly rather than from the server's clock — this app runs
 * in Azure and the deadline is not the server's afternoon.
 */
export function aptmDeadline(now: Date = new Date()): DeadlineState {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hour = get("hour") % 24;
  const minute = get("minute");
  const minutesRemaining = (APTM_DEADLINE_HOUR_CT - hour) * 60 - minute;

  return {
    deadlineCt: `${String(APTM_DEADLINE_HOUR_CT).padStart(2, "0")}:00 CT`,
    minutesRemaining,
    state: minutesRemaining <= 0 ? "past" : minutesRemaining <= 60 ? "soon" : "ok",
  };
}

export type TaxLine = {
  taxCode: string | null;
  taxableWages: number;
  tax: number;
  qtdTax?: number;
};

export type AptmCheck = {
  check: string;
  status: "pass" | "fail" | "warn" | "info";
  message: string;
  detail: unknown[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * ⚠️ The blank tax-code line must carry ZERO.
 *
 * There is one legitimately blank line — Yvon Agustin lives and works in
 * Wisconsin, so his Kentucky code is not taxable, and uploading with it blank
 * has never errored. Because there are no taxable wages and no tax, the pivot
 * shows 0 and 0, and that is fine.
 *
 * ⚠️ An AMOUNT on the blanks line is a different thing entirely: something is
 * uncoded, and it has to be tracked down before upload. So this checks the
 * VALUE, not the presence of the line.
 */
export function checkBlankTaxCode(lines: TaxLine[]): AptmCheck {
  const blanks = lines.filter((l) => !l.taxCode || l.taxCode.trim() === "");
  const withAmount = blanks.filter(
    (l) => round2(l.taxableWages) !== 0 || round2(l.tax) !== 0);

  return {
    check: "blank_tax_code",
    status: withAmount.length ? "fail" : "pass",
    message: withAmount.length
      ? `the blank tax-code line carries an amount — something is uncoded, find it before uploading`
      : blanks.length
        ? "blank tax-code line present and zero, as expected"
        : "no blank tax-code line",
    detail: withAmount.map((l) => ({ taxableWages: l.taxableWages, tax: l.tax })),
  };
}

/**
 * The Daily Tax pivot must tie to the payroll register, per office.
 *
 * The register splits employer and employee tax; the pivot total is their sum.
 * Comparing against either half alone is the easy mistake and always fails.
 */
export function checkPivotToRegister(
  lines: TaxLine[],
  register: { employeeTax: number; employerTax: number; taxableWages?: number },
  office: AptmOffice,
): AptmCheck {
  const pivotTax = round2(lines.reduce((s, l) => s + l.tax, 0));
  const pivotWages = round2(lines.reduce((s, l) => s + l.taxableWages, 0));
  const registerTax = round2(register.employeeTax + register.employerTax);
  const diff = round2(pivotTax - registerTax);

  const detail: unknown[] = [];
  if (Math.abs(diff) > 0.004) {
    detail.push({
      office, pivotTax, registerTax, diff,
      employeeTax: round2(register.employeeTax),
      employerTax: round2(register.employerTax),
      hint: "the pivot total is employer PLUS employee tax, not either alone",
    });
  }
  if (register.taxableWages !== undefined
      && Math.abs(round2(pivotWages - register.taxableWages)) > 0.004) {
    detail.push({
      office, pivotWages, registerWages: round2(register.taxableWages),
      diff: round2(pivotWages - register.taxableWages),
    });
  }

  return {
    check: "pivot_to_register",
    status: detail.length ? "fail" : "pass",
    message: detail.length
      ? `${office}: pivot ${pivotTax} vs register ${registerTax} (diff ${diff})`
      : `${office}: pivot ties to the register at ${pivotTax}`,
    detail,
  };
}

/**
 * The CSV preparation steps, as blocking gates.
 *
 * Each one is here because forgetting it produces an APTM error rather than a
 * bad number — the instructions name the error for all three.
 */
export type CsvPrep = {
  headerRowRemoved: boolean;
  footerBlankRowRemoved: boolean;
  savedAsCsv: boolean;
  /** ⚠️ An open file will not upload. It is the least obvious of the three. */
  fileClosed: boolean;
};

export function checkCsvPrep(p: CsvPrep): AptmCheck {
  const missing: string[] = [];
  if (!p.headerRowRemoved) missing.push("remove the header row — APTM errors on it");
  if (!p.footerBlankRowRemoved) missing.push("remove the trailing blank grey row");
  if (!p.savedAsCsv) missing.push("save as CSV, not xlsx — selecting the Excel file errors");
  if (!p.fileClosed) missing.push("CLOSE the file — an open file will not upload");

  return {
    check: "csv_prep",
    status: missing.length ? "fail" : "pass",
    message: missing.length ? `${missing.length} step${missing.length === 1 ? "" : "s"} left before upload`
                            : "file is ready to upload",
    detail: missing,
  };
}

/**
 * ⚠️ THE MONEY SAFETY RULE.
 *
 * From the instructions, and it is the most important sentence in them:
 * "If you do not have time to review to make sure that the file imported
 * correctly in APTM you should change the file status from Valid to Check …
 * this will prevent APTM from pulling funds until you have reviewed."
 *
 * So an upload that has not been verified must NOT sit in Valid. This states
 * which status the file should be in, given whether the post-import checks have
 * actually been done.
 */
export type PostImportReview = {
  totalMatchesRegister: boolean;
  eachTaxAmountTicked: boolean;
  qtdMatchesDailyTax: boolean;
};

export function aptmFileStatus(review: PostImportReview): AptmCheck {
  const done = review.totalMatchesRegister && review.eachTaxAmountTicked
    && review.qtdMatchesDailyTax;
  return {
    check: "aptm_file_status",
    status: done ? "pass" : "warn",
    message: done
      ? "reviewed — the file may be left Valid"
      : "NOT fully reviewed — set the file status to Check, which stops APTM pulling funds until it is",
    detail: done ? [] : [{
      totalMatchesRegister: review.totalMatchesRegister,
      eachTaxAmountTicked: review.eachTaxAmountTicked,
      qtdMatchesDailyTax: review.qtdMatchesDailyTax,
      requiredStatus: "Check",
    }],
  };
}

/** The whole APTM gate for one office. */
export function runAptmChecks(input: {
  office: AptmOffice;
  lines: TaxLine[];
  register: { employeeTax: number; employerTax: number; taxableWages?: number };
  csvPrep?: CsvPrep;
  review?: PostImportReview;
  now?: Date;
}): AptmCheck[] {
  const d = aptmDeadline(input.now);
  const out: AptmCheck[] = [{
    check: "deadline",
    status: d.state === "past" ? "fail" : d.state === "soon" ? "warn" : "info",
    message: d.state === "past"
      ? `past the ${d.deadlineCt} cutoff`
      : `${d.minutesRemaining} minutes until the ${d.deadlineCt} cutoff`,
    detail: [d],
  }];
  out.push(checkBlankTaxCode(input.lines));
  out.push(checkPivotToRegister(input.lines, input.register, input.office));
  if (input.csvPrep) out.push(checkCsvPrep(input.csvPrep));
  if (input.review) out.push(aptmFileStatus(input.review));
  return out;
}
