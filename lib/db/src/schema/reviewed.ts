import {
  pgTable,
  date,
  text,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

export const reviewedDriversTable = pgTable(
  "reviewed_drivers",
  {
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.weekStart, t.kfiId] })],
);
