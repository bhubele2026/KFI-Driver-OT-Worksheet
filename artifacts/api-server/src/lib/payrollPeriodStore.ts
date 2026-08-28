import { and, eq } from "drizzle-orm";
import { db, schema } from "./db.js";
import { periodDatesFor, labelFor, isoToExcelSerial } from "./payrollPeriod.js";

/**
 * Find or create the period row for a pay date.
 *
 * ⚠️ RACE-SAFE ON PURPOSE, and it was not before. This ran as find-then-insert
 * in two places, which means two concurrent callers for a pay date that does
 * not exist yet BOTH find nothing, BOTH insert, and the second one violates
 * `payroll_periods_date_cycle_idx` and 500s. That is not hypothetical: the
 * bridge pushes several chunks while somebody may be opening the board, and a
 * new pay date is exactly when it would happen — the first run of a new week.
 *
 * Now an upsert, then a read. `onConflictDoNothing` makes the losing writer a
 * no-op rather than an error, and the follow-up select returns whichever row
 * won.
 *
 * It also lived in TWO files with identical bodies. Duplicated persistence
 * logic drifts, and the copy that drifts is the one nobody is looking at.
 */
export async function ensurePayrollPeriod(payDate: string, isOffCycle: boolean) {
  // Off-cycle has no work week, so weekStart and ppe stay null.
  const d = isOffCycle ? null : periodDatesFor(payDate);

  await db.insert(schema.payrollPeriodsTable).values({
    payDate,
    label: labelFor(payDate, isOffCycle),
    weekStart: d?.weekStart ?? null,
    ppe: d ? isoToExcelSerial(d.ppeDate) : null,
    isOffCycle,
  }).onConflictDoNothing({
    target: [schema.payrollPeriodsTable.payDate, schema.payrollPeriodsTable.isOffCycle],
  });

  const found = await db.select().from(schema.payrollPeriodsTable)
    .where(and(eq(schema.payrollPeriodsTable.payDate, payDate),
               eq(schema.payrollPeriodsTable.isOffCycle, isOffCycle)))
    .limit(1);

  if (!found[0]) {
    // Both the insert and the read came back empty, which should be impossible.
    // Say so loudly rather than returning undefined into every caller.
    throw new Error(`could not create or read the period for ${payDate} (offCycle=${isOffCycle})`);
  }
  return found[0];
}
