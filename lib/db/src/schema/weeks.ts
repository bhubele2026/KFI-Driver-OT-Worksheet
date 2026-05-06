import { pgTable, date, timestamp } from "drizzle-orm/pg-core";

// One row per ingested week (Mon -> Sun). Tracks last refresh.
export const weeksTable = pgTable("weeks", {
  startDate: date("start_date").primaryKey(),
  endDate: date("end_date").notNull(),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
