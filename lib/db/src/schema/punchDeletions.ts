import {
  pgTable,
  serial,
  text,
  date,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Append-only audit of deleted punches. We hard-delete the original row
// (the dispatch UI assumes a single live punches table) but keep enough
// context here to attribute the delete during reconciliation disputes
// and to fold delete events into the per-driver "last touched" signal.
export const punchDeletionsTable = pgTable(
  "punch_deletions",
  {
    id: serial("id").primaryKey(),
    punchId: integer("punch_id").notNull(),
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    customer: text("customer"),
    source: text("source").notNull(),
    deletedBy: integer("deleted_by"),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("punch_deletions_week_kfi_idx").on(t.weekStart, t.kfiId),
  ],
);

export type PunchDeletion = typeof punchDeletionsTable.$inferSelect;
