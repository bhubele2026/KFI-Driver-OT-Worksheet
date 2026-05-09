import {
  pgTable,
  date,
  text,
  numeric,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

// Per (week, driver, date) snapshot of the Connecteam-side daily total at the
// moment of the most recent /refresh-connecteam call for that driver-week.
//
// Why store this:
//   The driver-detail "Matches Connecteam" parity badge needs a hard numeric
//   reference to compare the engine's computed daily totals against. Without
//   this snapshot the only available signal is the `edited`/`isManual` flags
//   on `punches`, which (a) miss the "edited then edited back to original"
//   case and (b) don't notice when the dispatcher's manual punches happen to
//   sum to the right number. Snapshotting the Connecteam baseline at refresh
//   time lets us answer "does the dashboard daily match what payroll would
//   see in Connecteam right now" with a real comparison.
//
// hours: numeric(7,2) so it lines up with the per-punch precision the engine
//   stores (see hoursEngine.ts and routes/punches.ts which both round to 2dp).
//   A 0.005 tolerance is applied at comparison time to absorb the last-bit
//   float noise.
export const connecteamDailySnapshotsTable = pgTable(
  "connecteam_daily_snapshots",
  {
    weekStart: date("week_start").notNull(),
    kfiId: text("kfi_id").notNull(),
    date: date("date").notNull(),
    hours: numeric("hours", { precision: 7, scale: 2 }).notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.weekStart, t.kfiId, t.date] })],
);
