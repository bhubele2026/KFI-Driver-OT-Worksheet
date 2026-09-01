import { addDays, sundayOf } from "./time";

/**
 * The date algebra of a pay period.
 *
 * Confirmed against live Zenople data rather than inferred — for pay date
 * 2026-08-28 the register reports AccountingPeriod 2026-08-23 and PPE
 * 2026-08-22, and the punch reports on disk are labelled
 * "PP 08.16.2026 to 08.22.2026 PD 08.28.2026". So:
 *
 *   weekStart (Sun) ──6d──> ppeDate (Sat) ──1d──> accountingPeriod (Sun)
 *                                                        │
 *                                                        └──5d──> payDate (Fri)
 *
 * Everything downstream keys off these four, so they live in one place.
 */
export type PeriodDates = {
  /** Friday. */
  payDate: string;
  /** Sunday the worked week starts. */
  weekStart: string;
  /** Saturday the worked week ends — Zenople's PayPeriodEndDate. */
  ppeDate: string;
  /** Sunday after the worked week — Zenople's AccountingPeriod. */
  accountingPeriod: string;
  /** Folder name on disk, e.g. "PD 08.28.2026". */
  label: string;
};

/** "2026-08-28" -> "08.28.2026", the form every folder and filename uses. */
export function toPdToken(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}.${d}.${y}`;
}

/** "08.28.2026" -> "2026-08-28". Returns null on anything else. */
export function fromPdToken(token: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(token.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * Bank holidays that can move a pay date (2025–2028, OBSERVED dates: a
 * Saturday holiday is listed on its Friday, a Sunday one on its Monday —
 * KFI's own record proves the observed rule: Holiday Pay treated 2026-07-03,
 * the observed Independence Day Friday, as the holiday).
 *
 * ⚠️ The rule this feeds (Brad, 2026-09-01): a period pays FRIDAY, unless
 * that Friday is a holiday — then it pays the THURSDAY before. Thanksgiving
 * (a Thursday) does not move anything: the Friday after it is a banking day.
 */
export const BANK_HOLIDAYS = new Set<string>([
  "2025-01-01", // New Year's Day (Wed)
  "2025-01-20", // MLK Day (Mon)
  "2025-02-17", // Washington's Birthday (Mon)
  "2025-05-26", // Memorial Day (Mon)
  "2025-06-19", // Juneteenth (Thu)
  "2025-07-04", // Independence Day (FRIDAY — pays Thu 07-03)
  "2025-09-01", // Labor Day (Mon)
  "2025-10-13", // Columbus Day (Mon)
  "2025-11-11", // Veterans Day (Tue)
  "2025-11-27", // Thanksgiving (Thu)
  "2025-12-25", // Christmas (Thu)
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-19", // MLK Day (Mon)
  "2026-02-16", // Washington's Birthday (Mon)
  "2026-05-25", // Memorial Day (Mon)
  "2026-06-19", // Juneteenth (FRIDAY — pays Thu 06-18)
  "2026-07-03", // Independence Day observed, Jul 4 is Sat (FRIDAY — pays Thu 07-02)
  "2026-09-07", // Labor Day (Mon)
  "2026-10-12", // Columbus Day (Mon)
  "2026-11-11", // Veterans Day (Wed)
  "2026-11-26", // Thanksgiving (Thu)
  "2026-12-25", // Christmas (FRIDAY — pays Thu 12-24)
  "2027-01-01", // New Year's Day (FRIDAY — pays Thu 2026-12-31)
  "2027-01-18", // MLK Day (Mon)
  "2027-02-15", // Washington's Birthday (Mon)
  "2027-05-31", // Memorial Day (Mon)
  "2027-06-18", // Juneteenth observed, Jun 19 is Sat (FRIDAY — pays Thu 06-17)
  "2027-07-05", // Independence Day observed, Jul 4 is Sun (Mon)
  "2027-09-06", // Labor Day (Mon)
  "2027-10-11", // Columbus Day (Mon)
  "2027-11-11", // Veterans Day (Thu)
  "2027-11-25", // Thanksgiving (Thu)
  "2027-12-24", // Christmas observed, Dec 25 is Sat (FRIDAY — pays Thu 12-23)
  "2027-12-31", // New Year's 2028 observed, Jan 1 is Sat (FRIDAY — pays Thu 12-30)
  "2028-01-17", // MLK Day (Mon)
  "2028-02-21", // Washington's Birthday (Mon)
  "2028-05-29", // Memorial Day (Mon)
  "2028-06-19", // Juneteenth (Mon)
  "2028-07-04", // Independence Day (Tue)
  "2028-09-04", // Labor Day (Mon)
  "2028-10-09", // Columbus Day (Mon)
  "2028-11-10", // Veterans Day observed, Nov 11 is Sat (FRIDAY — pays Thu 11-09)
  "2028-11-23", // Thanksgiving (Thu)
  "2028-12-25", // Christmas (Mon)
]);

export const isBankHoliday = (iso: string): boolean => BANK_HOLIDAYS.has(iso);

/**
 * The day a period whose nominal Friday is `fridayIso` actually pays:
 * Friday, unless it is a holiday → the Thursday before (Wednesday if that
 * Thursday is somehow a holiday too — defensive; the current list never is).
 */
export function payDateForWeekOf(fridayIso: string): string {
  if (!isBankHoliday(fridayIso)) return fridayIso;
  const thu = addDays(fridayIso, -1);
  return isBankHoliday(thu) ? addDays(fridayIso, -2) : thu;
}

/**
 * The nominal FRIDAY of the period a real pay date belongs to. The period
 * algebra (PPE, accounting period, worked week) is anchored on the week, so
 * a holiday-shifted Thursday must resolve to its Friday before deriving —
 * otherwise every downstream date lands one day early.
 */
export function nominalFridayFor(payDate: string): string {
  if (isFriday(payDate)) return payDate;
  const dow = new Date(`${payDate}T00:00:00Z`).getUTCDay();
  if (dow === 4 && isBankHoliday(addDays(payDate, 1))) return addDays(payDate, 1);
  if (dow === 3 && isBankHoliday(addDays(payDate, 1)) && isBankHoliday(addDays(payDate, 2))) {
    return addDays(payDate, 2);
  }
  return payDate; // off-cycle / arbitrary — caller validates separately
}

/**
 * A date someone may run a REGULAR period against: a non-holiday Friday, or
 * the holiday-shifted Thursday/Wednesday for its week. Everything else is a
 * typo or a scrubbed date-input — reject it before it mints a period row.
 */
export function isValidPayDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const nominal = nominalFridayFor(iso);
  return isFriday(nominal) && payDateForWeekOf(nominal) === iso;
}

/** One entry of the pay-date picker. */
export type PayDateOption = {
  payDate: string;
  label: string;
  /** True when a Friday holiday moved the pay day to Thursday. */
  holidayShifted: boolean;
};

/**
 * The valid pay dates around `todayIso` — `backN` completed/current periods
 * and `fwdN` upcoming ones, oldest first. This list is ARITHMETIC, not read
 * from payroll_periods, so junk rows minted before validation existed can
 * never surface in a picker.
 */
export function payDates(todayIso: string, backN: number, fwdN: number): PayDateOption[] {
  const anchor = nominalFridayFor(payDateFor(todayIso));
  const out: PayDateOption[] = [];
  for (let i = -backN; i <= fwdN; i++) {
    const friday = addDays(anchor, i * 7);
    const payDate = payDateForWeekOf(friday);
    out.push({ payDate, label: `PD ${toPdToken(payDate)}`, holidayShifted: payDate !== friday });
  }
  return out;
}

/** Derive every date of a regular weekly period from its pay date.
 *  Anchored on the NOMINAL FRIDAY, so a holiday-shifted Thursday pay date
 *  yields the same worked week / PPE / accounting period as its Friday. */
export function periodDatesFor(payDate: string): PeriodDates {
  const friday = nominalFridayFor(payDate);
  const accountingPeriod = addDays(friday, -5);
  const ppeDate = addDays(accountingPeriod, -1);
  const weekStart = addDays(ppeDate, -6);
  return { payDate, weekStart, ppeDate, accountingPeriod, label: `PD ${toPdToken(payDate)}` };
}

/**
 * The pay date a given day belongs to: the upcoming Friday, today included —
 * or that week's Thursday when the Friday is a holiday.
 *
 * Inclusive on purpose — Friday is a working day of the period that pays that
 * same day, and a sweep run on Friday morning must not jump a week ahead.
 */
export function payDateFor(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun … 5=Fri
  return payDateForWeekOf(addDays(iso, (5 - dow + 7) % 7));
}

/**
 * The PD folder is stamped from the template exactly 8 days before the pay
 * date, so this is when the app should expect the folder to appear.
 */
export function folderOpensOn(payDate: string): string {
  return addDays(payDate, -8);
}

/** Off-cycle folders carry a suffix; regular ones do not. */
export function labelFor(payDate: string, isOffCycle: boolean): string {
  return `PD ${toPdToken(payDate)}${isOffCycle ? " Off Cycle" : ""}`;
}

/** Parse a folder name back into a pay date + cycle flag. */
export function parsePeriodLabel(label: string): { payDate: string; isOffCycle: boolean } | null {
  const m = /^PD\s+(\d{2}\.\d{2}\.\d{4})(\s+Off\s*Cycle)?\s*$/i.exec(label.trim());
  if (!m) return null;
  const payDate = fromPdToken(m[1]!);
  return payDate ? { payDate, isOffCycle: Boolean(m[2]) } : null;
}

/**
 * Excel serial for a date, matching how `exportSnapshots.ppe` is stored.
 * Day 1 is 1900-01-01 and Excel's phantom 1900-02-29 costs one day.
 */
export function isoToExcelSerial(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 25_569;
}

/** Sanity guard: a regular period must pay on a Friday. */
export function isFriday(iso: string): boolean {
  return new Date(`${iso}T00:00:00Z`).getUTCDay() === 5;
}

/** Re-exported so callers get the week helpers from one module. */
export { sundayOf };
