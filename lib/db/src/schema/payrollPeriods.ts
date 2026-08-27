import { pgTable, serial, text, date, integer, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * A pay period — the unit the whole weekly run hangs off.
 *
 * On disk a period is a TEMPLATE INSTANTIATION, not a folder that grows:
 * `PD 12.31.2026/` is the stamp (9 subfolders + a changes workbook), copied
 * exactly 8 days before the pay date. Regular periods are weekly Fridays.
 *
 * ⚠️ Off-cycle periods are a DIFFERENT ENTITY, not a variant: flat folders,
 * 2-10 files, event-triggered (10 of 12 observed were advances), no timesheet
 * stage and no changes workbook. They are kept in this table so a pay date is
 * one concept, but almost every stage below skips them — hence isOffCycle.
 */
export const payrollPeriodsTable = pgTable(
  "payroll_periods",
  {
    id: serial("id").primaryKey(),
    /** Friday for regular periods; any weekday for off-cycle. */
    payDate: date("pay_date").notNull(),
    /** Folder name as it exists on disk, e.g. "PD 08.28.2026 Off Cycle". */
    label: text("label").notNull(),
    /**
     * Sunday of the week worked. NULL for off-cycle, which has no work week.
     * The Zenople accounting period is always the Sunday AFTER this.
     */
    weekStart: date("week_start"),
    /** Pay-period-end as an Excel serial, matching exportSnapshots.ppe. */
    ppe: integer("ppe"),
    isOffCycle: boolean("is_off_cycle").notNull().default(false),
    /** open | processing | closed */
    status: text("status").notNull().default("open"),
    /** Absolute path of the SharePoint PD folder, when the bridge has seen it. */
    folderPath: text("folder_path"),
    folderSeenAt: timestamp("folder_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Off-cycle and regular can in principle land on the same date.
    uniqueIndex("payroll_periods_date_cycle_idx").on(t.payDate, t.isOffCycle),
    index("payroll_periods_week_idx").on(t.weekStart),
    index("payroll_periods_status_idx").on(t.status),
  ],
);

export type PayrollPeriod = typeof payrollPeriodsTable.$inferSelect;
