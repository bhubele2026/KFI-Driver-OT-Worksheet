import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Per-customer "this external id is not a driver" list. When the dispatcher
// marks an unmapped badge / employee id as "Not a driver — never import for
// this customer" in the upload preview, we persist (customer, externalId)
// here. On every subsequent extract for the same customer the server filters
// matching ids out of the unmappedIds list so the dispatcher isn't nagged
// week after week about people who don't belong in payroll.
//
// Keyed case-insensitively on (customer, externalId) to mirror how the
// embedded mapping treats badge numbers (file casing is inconsistent).
export const customerIgnoredExternalsTable = pgTable(
  "customer_ignored_externals",
  {
    id: serial("id").primaryKey(),
    customer: text("customer").notNull(),
    externalId: text("external_id").notNull(),
    sampleName: text("sample_name"),
    note: text("note"),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_ignored_externals_unique_idx").on(
      sql`lower(${t.customer})`,
      sql`lower(${t.externalId})`,
    ),
  ],
);

export type CustomerIgnoredExternal =
  typeof customerIgnoredExternalsTable.$inferSelect;
