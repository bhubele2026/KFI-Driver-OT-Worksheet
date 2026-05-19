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
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Unified punch table. Holds rows from all sources:
//   - Driver, source='Driver', isManual=false: Connecteam imports
//   - Driver, source='Driver', isManual=true:  manually entered driver punches
//   - Customer, source='Customer', isManual=false: file imports (Penda, Adient, ...)
//   - Customer, source='Customer', isManual=true:  manually entered customer punches
// Connecteam refresh wipes only (week, source='Driver', isManual=false).
// Customer file upload wipes only (week, source='Customer', customer=X, isManual=false).
// Manual rows are never auto-deleted. Edits update rows in place.
export const punchesTable = pgTable(
  "punches",
  {
    id: serial("id").primaryKey(),
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    customer: text("customer"),
    source: text("source").notNull(), // 'Driver' | 'Customer'
    date: text("date").notNull(), // YYYY-MM-DD in display tz
    clockIn: text("clock_in").notNull(), // "YYYY-MM-DD H:MM AM/PM" (display tz)
    clockOut: text("clock_out").notNull(),
    hours: numeric("hours", { precision: 7, scale: 3 }).notNull(),
    payType: text("pay_type"), // 'Reg' | 'OT' | null
    dispTz: text("disp_tz").notNull().default("America/Chicago"),
    isManual: boolean("is_manual").notNull().default(false),
    edited: boolean("edited").notNull().default(false),
    ctExternalKey: text("ct_external_key"), // userId:start:end for Connecteam dedupe
    fileOrigin: text("file_origin"),
    createdBy: integer("created_by"),
    updatedBy: integer("updated_by"),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("punches_week_kfi_idx").on(t.weekStart, t.kfiId),
    index("punches_week_source_idx").on(t.weekStart, t.source),
    uniqueIndex("punches_ct_key_idx").on(t.weekStart, t.ctExternalKey),
  ],
);

export type Punch = typeof punchesTable.$inferSelect;
