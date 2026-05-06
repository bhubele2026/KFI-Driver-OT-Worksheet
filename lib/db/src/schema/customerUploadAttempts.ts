import {
  pgTable,
  text,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
