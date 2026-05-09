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

// Append-only notes attached to a driver-week. Two flavors:
//   - punch_id IS NULL  → week-level note (general context for the driver-week)
//   - punch_id IS NOT NULL → row-level note tied to a specific punch
// punch_id is intentionally a plain integer (not a FK) so deleting a punch
// does NOT cascade or null out the column. The note keeps the original
// punch_id and the UI renders an "(orphaned punch)" tag when the punch row
// is gone, so reviewer/supervisor context isn't lost on delete.
//
// author_role is denormalized at write-time ('reviewer' | 'supervisor' |
// 'admin') so changing the author's role later doesn't retroactively
// rewrite history. Soft-delete columns (deleted_at, deleted_by_user_id) let
// admins hide a note while preserving the row for audit.
export const driverNotesTable = pgTable(
  "driver_notes",
  {
    id: serial("id").primaryKey(),
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    punchId: integer("punch_id"),
    body: text("body").notNull(),
    authorUserId: integer("author_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    authorRole: text("author_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: integer("deleted_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    index("idx_driver_notes_week_kfi").on(t.weekStart, t.kfiId),
    index("idx_driver_notes_punch").on(t.punchId),
  ],
);

export type DriverNote = typeof driverNotesTable.$inferSelect;
