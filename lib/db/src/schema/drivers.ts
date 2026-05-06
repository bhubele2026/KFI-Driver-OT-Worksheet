import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

export const driversTable = pgTable("drivers", {
  kfiId: text("kfi_id").primaryKey(),
  name: text("name").notNull(),
  customer: text("customer").notNull(),
  ctUserId: integer("ct_user_id"),
  isDriver: boolean("is_driver").notNull().default(true),
  isArchived: boolean("is_archived").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Driver = typeof driversTable.$inferSelect;
