import {
  pgTable,
  serial,
  integer,
  text,
  date,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Append-only audit trail for review-status and lock changes on a driver-week.
// action ∈ { 'lock', 'unlock', 'review-good', 'review-bad', 'review-clear' }.
// actorUserId is nullable so deletes of the user row keep the history.
export const driverWeekAuditLogTable = pgTable(
  "driver_week_audit_log",
  {
    id: serial("id").primaryKey(),
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_dw_audit_week_kfi").on(t.weekStart, t.kfiId),
    index("idx_dw_audit_created").on(t.createdAt),
  ],
);

export type DriverWeekAuditLog = typeof driverWeekAuditLogTable.$inferSelect;
