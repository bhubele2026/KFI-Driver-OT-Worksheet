import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * One row per Zenople export download: the exact rows that went into the
 * workbook, captured at export time. Rates are merged live-from-Zenople at
 * export (live wins), so nothing else in the system records what was
 * actually sent — this table is the only true "what we exported" side of
 * the exported-vs-paid reconciliation on the Master Dash.
 *
 * `rows` is the ZenopleRow array WITHOUT the ssn field — SSNs must never
 * leave this app through the pulse endpoint that serves these snapshots.
 */
export const exportSnapshotsTable = pgTable(
  "export_snapshots",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // App week Sunday (ISO date).
    weekStart: text("week_start").notNull(),
    // Pay-period-end Saturday as the Excel serial Zenople stamps on rows.
    ppe: integer("ppe").notNull(),
    exportedBy: integer("exported_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    rowCount: integer("row_count").notNull().default(0),
    driverCount: integer("driver_count").notNull().default(0),
    // { byCode: { [code]: { hours, pay, bill } }, hours, pay, bill }
    totals: jsonb("totals").notNull(),
    // ZenopleRow[] minus ssn.
    rows: jsonb("rows").notNull(),
  },
  (t) => [
    index("export_snapshots_week_idx").on(t.weekStart),
    index("export_snapshots_created_idx").on(t.createdAt),
  ],
);

export type ExportSnapshot = typeof exportSnapshotsTable.$inferSelect;
