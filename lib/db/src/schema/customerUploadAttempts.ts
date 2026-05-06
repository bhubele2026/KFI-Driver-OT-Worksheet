import {
  pgTable,
  text,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export interface UnmappedIdEntry {
  id: string;
  count: number;
  sampleName: string | null;
}

// Tracks the most recent upload attempt for each (week, customer) pair so the
// dashboard can show persistent "last upload outcome" status that survives a
// page refresh. One row per (week_start, customer); upserted on every attempt.
export const customerUploadAttemptsTable = pgTable(
  "customer_upload_attempts",
  {
    weekStart: date("week_start").notNull(),
    customer: text("customer").notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFileName: text("last_file_name"),
    lastError: text("last_error"),
    lastSource: text("last_source"), // 'parser' | 'ai'
    // Badge / employee IDs that appeared in the last upload but didn't map to
    // a known KFI driver. Persisted per (week, customer) so the warning
    // survives a dashboard refresh. Cleared (empty array) on a clean upload.
    // Each entry: { id, count, sampleName? } — sampleName is the driver name
    // as it appeared next to the id in the source file, when the parser
    // could pick one up (Adient, IWG, sometimes DeLallo).
    lastUnmappedIds: jsonb("last_unmapped_ids").$type<UnmappedIdEntry[]>(),
  },
  (t) => [
    uniqueIndex("customer_upload_attempts_week_customer_idx").on(
      t.weekStart,
      t.customer,
    ),
  ],
);

export type CustomerUploadAttempt =
  typeof customerUploadAttemptsTable.$inferSelect;
