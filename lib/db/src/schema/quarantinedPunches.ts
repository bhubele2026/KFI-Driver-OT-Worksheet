import {
  pgTable,
  serial,
  text,
  date,
  numeric,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Forensic copy of `punches` rows that were attributed to a deleted
// driver / customer row (Task #359). Captures every original column
// from `punches` plus enough context to reconstruct what was wiped
// (`original_driver_name`, `original_driver_customer`, the reason
// string the cleanup used, and when the move happened). No foreign
// keys back to drivers / customers — those rows are gone by the time
// we land here.
//
// The cleanup move-then-delete logic lives in
// `lib/db/src/preMigrate.ts` (`purge_e2e_onboarding_leak_2026` fixup)
// and runs inside one transaction so a partial failure rolls back.
export const quarantinedPunchesTable = pgTable(
  "quarantined_punches",
  {
    id: serial("id").primaryKey(),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    quarantineReason: text("quarantine_reason").notNull(),
    originalDriverName: text("original_driver_name"),
    originalDriverCustomer: text("original_driver_customer"),
    // Original punch id from the live `punches` table (not a FK — the
    // source row has been deleted by the time we write here).
    originalPunchId: integer("original_punch_id").notNull(),
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    customer: text("customer"),
    source: text("source").notNull(),
    date: text("date").notNull(),
    clockIn: text("clock_in").notNull(),
    clockOut: text("clock_out").notNull(),
    hours: numeric("hours", { precision: 7, scale: 3 }).notNull(),
    payType: text("pay_type"),
    dispTz: text("disp_tz").notNull().default("America/Chicago"),
    isManual: boolean("is_manual").notNull().default(false),
    edited: boolean("edited").notNull().default(false),
    ctExternalKey: text("ct_external_key"),
    fileOrigin: text("file_origin"),
    createdBy: integer("created_by"),
    updatedBy: integer("updated_by"),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    flaggedForReview: boolean("flagged_for_review").notNull().default(false),
    flaggedBy: integer("flagged_by"),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    originalCreatedAt: timestamp("original_created_at", { withTimezone: true }),
    originalUpdatedAt: timestamp("original_updated_at", { withTimezone: true }),
  },
  (t) => [
    index("quarantined_punches_week_kfi_idx").on(t.weekStart, t.kfiId),
    index("quarantined_punches_quarantined_at_idx").on(t.quarantinedAt),
  ],
);

export type QuarantinedPunch = typeof quarantinedPunchesTable.$inferSelect;
