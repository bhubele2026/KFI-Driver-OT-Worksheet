import {
  pgTable,
  text,
  timestamp,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Per-customer snooze for the dashboard's "promote this AI customer to a real
// parser" banner. Admins use this when they've decided a particular customer
// should stay on the AI flow (seasonal run, unstable file format, etc.) so the
// suggestion stops being noise. A row with snoozedUntil = NULL is a
// snooze-forever; a non-null timestamp is a time-bounded snooze that lapses
// automatically (the customer-uploads response treats expired rows as inactive
// and re-surfaces the suggestion).
export const parserPromotionSnoozesTable = pgTable(
  "parser_promotion_snoozes",
  {
    customer: text("customer").primaryKey(),
    snoozedAt: timestamp("snoozed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    snoozedByUserId: integer("snoozed_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    reason: text("reason"),
  },
  (t) => [
    uniqueIndex("parser_promotion_snoozes_customer_idx").on(
      sql`lower(${t.customer})`,
    ),
  ],
);

export type ParserPromotionSnooze =
  typeof parserPromotionSnoozesTable.$inferSelect;
