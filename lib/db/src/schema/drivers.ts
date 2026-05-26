import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const driversTable = pgTable(
  "drivers",
  {
    kfiId: text("kfi_id").primaryKey(),
    name: text("name").notNull(),
    customer: text("customer").notNull(),
    ctUserId: integer("ct_user_id"),
    isDriver: boolean("is_driver").notNull().default(true),
    isArchived: boolean("is_archived").notNull().default(false),
    displayTz: text("display_tz"),
    displayTzUpdatedBy: integer("display_tz_updated_by"),
    displayTzUpdatedAt: timestamp("display_tz_updated_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Task #401: dashboard and customer-files panel routinely filter the
  // driver roster by customer (e.g. "all Penda drivers for this week");
  // without this index Postgres seq-scans the drivers table on every read.
  (t) => [index("drivers_customer_idx").on(t.customer)],
);

export type Driver = typeof driversTable.$inferSelect;
