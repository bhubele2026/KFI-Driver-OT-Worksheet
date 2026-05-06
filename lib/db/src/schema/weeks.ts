import { pgTable, date, timestamp, integer } from "drizzle-orm/pg-core";

// One row per ingested week (Mon -> Sun). Tracks last refresh.
export const weeksTable = pgTable("weeks", {
  startDate: date("start_date").primaryKey(),
  endDate: date("end_date").notNull(),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  lastRefreshedBy: integer("last_refreshed_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
