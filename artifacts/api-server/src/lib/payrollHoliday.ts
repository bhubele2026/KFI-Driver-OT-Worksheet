import { addDays, sundayOf } from "./time.js";

/**
 * Holiday Pay eligibility.
 *
 * A 26-week look-back done today with pivot tables, conditional formatting and
 * a manual pass over anyone with a voided cheque. Four conditions have to hold
 * at once, and the reason it takes an afternoon is that the void handling
 * interacts with the check-date count.
 */

/** ⚠️ Flat rate. Pay unit 1, pay rate 50, every bill column zero. */
export const HOLIDAY_PAY_RATE = 50;
export const HOLIDAY_TRANSACTION_CODE = "Holiday Pay";

/** 26 calendar weeks BEFORE the week the holiday falls in. */
export const LOOKBACK_WEEKS = 26;
/** At least this many unique check dates. */
export const REQUIRED_CHECK_DATES = 26;
/** At least this many WORKED hours. */
export const REQUIRED_WORKED_HOURS = 720;

export type LookbackWindow = { start: string; end: string; holidayWeekStart: string };

/**
 * The look-back window for a holiday.
 *
 * Measured from the START of the holiday's week, so a holiday falling on a
 * Thursday and one falling on a Monday of the same week get the identical
 * window — which is what "the 26 calendar weeks prior to the week that the
 * holiday is in" means.
 */
export function holidayLookback(holidayDate: string): LookbackWindow {
  const holidayWeekStart = sundayOf(holidayDate);
  const end = addDays(holidayWeekStart, -1);
  const start = addDays(holidayWeekStart, -LOOKBACK_WEEKS * 7);
  return { start, end, holidayWeekStart };
}

/** One payment row from the Holiday Pay Payment Detail report. */
export type HolidayPaymentRow = {
  personId: number;
  name?: string | null;
  checkDate: string;
  /** ⚠️ A number containing V or R is a void or a reversal. */
  checkNumber?: string | null;
  rtHours?: number | null;
  otHours?: number | null;
  dtHours?: number | null;
  otherHours?: number | null;
  /** Present in the report but NOT worked time. */
  holidayHours?: number | null;
  ptoHours?: number | null;
};

export type AssignmentRow = {
  personId: number;
  hireDate?: string | null;
  /** Null end date means the assignment is active. */
  endDate?: string | null;
};

export type EligibilityResult = {
  personId: number;
  name: string | null;
  eligible: boolean;
  uniqueCheckDates: number;
  workedHours: number;
  hasActiveAssignment: boolean;
  hiredBeforeLookback: boolean;
  /** Voided or reversed cheques found, which is why a naive count is wrong. */
  voidedCheckDates: string[];
  reasons: string[];
};

const isVoidOrReversal = (checkNumber: string | null | undefined): boolean => {
  const s = String(checkNumber ?? "");
  return /[a-z]/i.test(s) && /[VR]/i.test(s);
};

/**
 * ⚠️ WORKED hours only. Holiday and PTO are in the report and must not count —
 * "in theory Holiday and PTO doesn't count because it isn't worked hours".
 */
const workedHoursOf = (r: HolidayPaymentRow): number =>
  (r.rtHours ?? 0) + (r.otHours ?? 0) + (r.dtHours ?? 0) + (r.otherHours ?? 0);

/**
 * Assess one person against all four conditions.
 *
 * ⚠️ THE CHECK-DATE COUNT IS OF DISTINCT DATES, NOT OF ROWS. Someone with a
 * void and a reissue has two rows on one date, and counting rows would credit
 * them a week they did not work. The instructions handle this by hand —
 * highlighting duplicates, then "eliminate these checks from the count by
 * selecting only one check for that pay check date". Counting distinct dates
 * does the same thing and cannot be forgotten.
 */
export function assessEligibility(
  personId: number,
  payments: HolidayPaymentRow[],
  assignments: AssignmentRow[],
  window: LookbackWindow,
  opts: { quitBeforeCheckDate?: boolean } = {},
): EligibilityResult {
  const mine = payments.filter(
    (p) => p.personId === personId
      && p.checkDate >= window.start && p.checkDate <= window.end);

  const dates = new Set(mine.map((p) => p.checkDate));
  const voidedCheckDates = [...new Set(
    mine.filter((p) => isVoidOrReversal(p.checkNumber)).map((p) => p.checkDate))];

  // Worked hours: a voided cheque's hours are not worked hours either.
  const workedHours = Math.round(
    mine.filter((p) => !isVoidOrReversal(p.checkNumber))
      .reduce((s, p) => s + workedHoursOf(p), 0) * 100) / 100;

  const assignment = assignments.find((a) => a.personId === personId);
  const hasActiveAssignment = assignment !== undefined && !assignment.endDate;
  const hiredBeforeLookback =
    assignment?.hireDate != null && assignment.hireDate <= window.start;

  const reasons: string[] = [];
  if (dates.size < REQUIRED_CHECK_DATES) {
    reasons.push(`${dates.size} unique check dates, needs ${REQUIRED_CHECK_DATES}`);
  }
  if (workedHours < REQUIRED_WORKED_HOURS) {
    reasons.push(`${workedHours} worked hours, needs ${REQUIRED_WORKED_HOURS}`);
  }
  if (!hasActiveAssignment) {
    reasons.push(assignment ? `assignment ended ${assignment.endDate}` : "no assignment found");
  }
  if (assignment?.hireDate != null && !hiredBeforeLookback) {
    reasons.push(`hired ${assignment.hireDate}, after the look-back opened ${window.start}`);
  }
  if (opts.quitBeforeCheckDate) {
    reasons.push("quit before the check date — will not be working when it pays");
  }

  return {
    personId,
    name: mine[0]?.name ?? null,
    eligible: reasons.length === 0,
    uniqueCheckDates: dates.size,
    workedHours,
    hasActiveAssignment,
    hiredBeforeLookback,
    voidedCheckDates,
    reasons,
  };
}

/** Assess everyone appearing in the payment report. */
export function assessAll(
  payments: HolidayPaymentRow[],
  assignments: AssignmentRow[],
  window: LookbackWindow,
  quitPersonIds: ReadonlySet<number> = new Set(),
): EligibilityResult[] {
  const ids = [...new Set(payments.map((p) => p.personId))];
  return ids
    .map((id) => assessEligibility(id, payments, assignments, window,
                                   { quitBeforeCheckDate: quitPersonIds.has(id) }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible)
                    || (a.name ?? "").localeCompare(b.name ?? ""));
}

export type HolidayImportRow = {
  Customer: string;
  Person: string;
  SSN: string;
  JobId: string;
  PersonId: number;
  TransactionCode: string;
  "Pay Unit": number;
  "Pay Rate": number;
  "Bill Unit": number;
  "Bill Rate": number;
  "Item Pay": number;
  "Item Bill": number;
  PPE: string;
};

/**
 * Build the import rows for everyone eligible.
 *
 * ⚠️ Every bill column is zero — holiday pay is not billed to the customer.
 * PPE is the last day of the work week, matching the master export.
 */
export function buildHolidayImport(
  eligible: EligibilityResult[],
  lookup: (personId: number) => { customer: string; person: string; ssn: string; jobId: string } | undefined,
  ppe: string,
): { rows: HolidayImportRow[]; skipped: number[] } {
  const rows: HolidayImportRow[] = [];
  const skipped: number[] = [];

  for (const e of eligible) {
    if (!e.eligible) continue;
    const info = lookup(e.personId);
    // Better to report a gap than to emit a row with blanks in it.
    if (!info) { skipped.push(e.personId); continue; }
    rows.push({
      Customer: info.customer, Person: info.person, SSN: info.ssn, JobId: info.jobId,
      PersonId: e.personId,
      TransactionCode: HOLIDAY_TRANSACTION_CODE,
      "Pay Unit": 1,
      "Pay Rate": HOLIDAY_PAY_RATE,
      "Bill Unit": 0, "Bill Rate": 0, "Item Pay": 0, "Item Bill": 0,
      PPE: ppe,
    });
  }
  return { rows, skipped };
}

/** Summary for the tile. */
export function holidaySummary(results: EligibilityResult[]) {
  const eligible = results.filter((r) => r.eligible);
  return {
    assessed: results.length,
    eligible: eligible.length,
    withVoids: results.filter((r) => r.voidedCheckDates.length > 0).length,
    shortOnCheckDates: results.filter((r) => r.uniqueCheckDates < REQUIRED_CHECK_DATES).length,
    shortOnHours: results.filter((r) => r.workedHours < REQUIRED_WORKED_HOURS).length,
    noActiveAssignment: results.filter((r) => !r.hasActiveAssignment).length,
    totalCost: eligible.length * HOLIDAY_PAY_RATE,
  };
}
