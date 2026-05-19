import {
  pgTable,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { driversTable } from "./drivers";
import { usersTable } from "./users";

// Per-driver manual customer override. One row per overridden driver, keyed by
// kfi_id. The Connecteam refresh path NEVER touches this table — `drivers.customer`
// continues to receive the roster's current value, so we can show
// "original: X" in the UI while the override wins for display + grouping
// on the week dashboard.
export const driverCustomerOverridesTable = pgTable(
  "driver_customer_overrides",
  {
    kfiId: text("kfi_id")
      .primaryKey()
      .references(() => driversTable.kfiId, { onDelete: "cascade" }),
    overrideCustomer: text("override_customer").notNull(),
    setByUserId: integer("set_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    setAt: timestamp("set_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type DriverCustomerOverride =
  typeof driverCustomerOverridesTable.$inferSelect;
