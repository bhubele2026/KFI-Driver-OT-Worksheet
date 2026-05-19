import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Per-customer default display timezone for customer-file uploads. The
// upload route consults this so a dispatcher doesn't have to re-pick the
// same tz on every weekly upload of (e.g.) an Adient file. Per-upload
// pickers still override this for a single upload.
export const customerTzPreferencesTable = pgTable(
  "customer_tz_preferences",
  {
    customer: text("customer").notNull(),
    displayTz: text("display_tz").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    updatedBy: integer("updated_by"),
  },
  (t) => [
    uniqueIndex("customer_tz_preferences_customer_idx").on(
      sql`lower(${t.customer})`,
    ),
  ],
);

export type CustomerTzPreference = typeof customerTzPreferencesTable.$inferSelect;
