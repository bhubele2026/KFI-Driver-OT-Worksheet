import {
  pgTable,
  text,
  timestamp,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Per-customer active/inactive flag for the customer-files panel. A row in
// this table means the customer is currently inactive (hidden from the
// per-week panel). Reactivating = deleting the row. The unique index is on
// lower(customer) so the displayName casing in KNOWN_CUSTOMERS, AI-imported
// customers, and admin input all collapse to the same key.
export const customerActiveStateTable = pgTable(
  "customer_active_state",
  {
    customer: text("customer").primaryKey(),
    inactiveAt: timestamp("inactive_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    inactiveByUserId: integer("inactive_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("customer_active_state_customer_idx").on(
      sql`lower(${t.customer})`,
    ),
  ],
);

export type CustomerActiveState =
  typeof customerActiveStateTable.$inferSelect;
