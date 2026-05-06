import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Persists per-customer driver-name decisions made during the
// "New customer file" (AI-extract) flow so the dispatcher doesn't have to
// re-map the same names every week. Keyed by (customer, nameOnDoc) — the
// uniqueness is case-insensitive so "ACME" and "acme" share an alias.
export const customerNameAliasesTable = pgTable(
  "customer_name_aliases",
  {
    customer: text("customer").notNull(),
    nameOnDoc: text("name_on_doc").notNull(),
    kfiId: text("kfi_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    updatedBy: integer("updated_by"),
  },
  (t) => [
    uniqueIndex("customer_name_aliases_customer_name_idx").on(
      sql`lower(${t.customer})`,
      sql`lower(${t.nameOnDoc})`,
    ),
  ],
);

export type CustomerNameAlias = typeof customerNameAliasesTable.$inferSelect;
