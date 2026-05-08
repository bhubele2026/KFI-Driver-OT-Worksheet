import {
  pgTable,
  date,
  text,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

// Per (week, driver) review + lock state.
//
// status:
//   - 'good'  — punches reconciled and approved
//   - 'bad'   — flagged as needing correction
//   - null    — not reviewed (row may still exist if the driver-week is locked)
//
// lockedAt / lockedByUserId:
//   - non-null  — the driver-week is frozen. Connecteam refresh, customer-file
//     uploads, manual punch entry, and punch CRUD return 423 for this driver
//     until it is unlocked. Only supervisors and admins can lock/unlock.
//
// A row exists when EITHER status is non-null OR the driver-week is locked.
// When both clear, the row is deleted.
export const reviewedDriversTable = pgTable(
  "reviewed_drivers",
  {
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    status: text("status"),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedByUserId: integer("locked_by_user_id"),
  },
  (t) => [primaryKey({ columns: [t.weekStart, t.kfiId] })],
);
