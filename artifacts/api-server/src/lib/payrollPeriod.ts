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

/** Derive every date of a regular weekly period from its pay date. */
export function periodDatesFor(payDate: string): PeriodDates {
  const accountingPeriod = addDays(payDate, -5);
  const ppeDate = addDays(accountingPeriod, -1);
  const weekStart = addDays(ppeDate, -6);
  return { payDate, weekStart, ppeDate, accountingPeriod, label: `PD ${toPdToken(payDate)}` };
}

/**
 * The pay date a given day belongs to: the upcoming Friday, today included.
 *
 * Inclusive on purpose — Friday is a working day of the period that pays that
 * same day, and a sweep run on Friday morning must not jump a week ahead.
 */
export function payDateFor(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun … 5=Fri
  return addDays(iso, (5 - dow + 7) % 7);
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
