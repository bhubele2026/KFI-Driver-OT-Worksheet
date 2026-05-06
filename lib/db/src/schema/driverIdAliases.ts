import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { driversTable } from "./drivers";

// Admin-managed extension of `EMBEDDED_MAPPING` in
// `artifacts/api-server/src/lib/mappings.ts`. Lets dispatchers map a customer
// payroll id (badge #, TELD code, employee number, etc.) to an existing KFI
// driver without a code change. Loaded on every customer-file upload and
// merged with EMBEDDED_MAPPING at parse time. DB rows take precedence over
// the static map so an admin can also override a stale embedded entry.
export const driverIdAliasesTable = pgTable(
  "driver_id_aliases",
  {
    externalId: text("external_id").primaryKey(),
    kfiId: text("kfi_id")
      .notNull()
      .references(() => driversTable.kfiId, { onDelete: "cascade" }),
    customer: text("customer"),
    sampleName: text("sample_name"),
    note: text("note"),
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
    uniqueIndex("driver_id_aliases_external_id_lower_idx").on(
      sql`lower(${t.externalId})`,
    ),
  ],
);

export type DriverIdAlias = typeof driverIdAliasesTable.$inferSelect;
