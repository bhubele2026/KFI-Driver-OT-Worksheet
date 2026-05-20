import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Single source of truth for the dispatcher-managed customer list. Replaces
// the hand-edited `KNOWN_CUSTOMERS` array in
// `artifacts/api-server/src/lib/parsers/customers.ts` and consolidates the
// per-customer active/inactive flag from the dropped
// `customer_active_state` table. Filename routing, customer dropdowns, and
// the customer-files panel all read from here.
//
// `sortOrder` keeps the per-week panel display stable across migrations —
// the seed inserts the legacy KNOWN_CUSTOMERS in their original order with
// gaps of 10 so an admin can slide a new customer in between two existing
// rows without renumbering.
export const customersTable = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    displayName: text("display_name").notNull(),
    filenameKeywords: text("filename_keywords").array().notNull(),
    extensions: text("extensions").array().notNull(),
    active: boolean("active").notNull().default(true),
    // Per-customer opt-in for the Claude→Gemini cross-provider fallback in
    // AI extraction. OFF by default after Task #297: a single bad upload
    // was eating ~$3 of spend because a transient Claude failure
    // automatically rerouted the entire load to Gemini, multiplying the
    // tokens spent. Customers whose format is stable enough that the
    // dispatcher would rather lean on the fallback can flip this on per
    // row from /admin/customers.
    allowGeminiFallback: boolean("allow_gemini_fallback")
      .notNull()
      .default(false),
    sortOrder: integer("sort_order").notNull().default(1000),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    updatedBy: integer("updated_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("customers_display_name_lower_idx").on(
      sql`lower(${t.displayName})`,
    ),
  ],
);

export type Customer = typeof customersTable.$inferSelect;
