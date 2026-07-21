import { addWeeks, format, startOfWeek } from "date-fns";

/**
 * The week the app should open on. Payroll is reconciled AFTER a week ends, so
 * the working week is the most-recently-completed Sun–Sat week (last week), not
 * the current in-progress calendar week. On Mon 2026-07-21 → "2026-07-12".
 *
 * Defaulting here guides a Connecteam refresh to the correct week and, if last
 * week hasn't been pulled yet, lands there empty (prompting the right refresh)
 * instead of populating the in-progress current week.
 */
export function payWeekStart(today: Date = new Date()): string {
  return format(
    addWeeks(startOfWeek(today, { weekStartsOn: 0 }), -1),
    "yyyy-MM-dd",
  );
}
