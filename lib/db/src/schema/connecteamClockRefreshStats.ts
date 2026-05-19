import { pgTable, integer, text, timestamp, boolean, date } from "drizzle-orm/pg-core";

// Persists a per-clock snapshot of the most recent Connecteam refresh so the
// admin clocks-audit card can render shift counts and per-clock failures
// after the refresh window has closed. One row per clock id; upserted in the
// refresh route. errorMessage is non-null when the per-clock fetch threw.
export const connecteamClockRefreshStatsTable = pgTable(
  "connecteam_clock_refresh_stats",
  {
    clockId: integer("clock_id").primaryKey(),
    clockName: text("clock_name").notNull(),
    isArchived: boolean("is_archived").notNull().default(false),
    lastWeekStart: date("last_week_start"),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }).notNull(),
    shiftCount: integer("shift_count").notNull().default(0),
    errorMessage: text("error_message"),
  },
);

export type ConnecteamClockRefreshStat =
  typeof connecteamClockRefreshStatsTable.$inferSelect;
