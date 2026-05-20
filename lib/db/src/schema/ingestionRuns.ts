import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  doublePrecision,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-upload AI-extraction telemetry. One row written at the end of
 * EVERY aiExtractRows invocation (success, budget_exceeded, or
 * extraction_failed) so an admin can audit spend after the fact and
 * see which uploads tripped the safety net (Task #297). The matching
 * `ingest_done` info log is the live signal; this table is the
 * persisted audit trail surfaced via /admin/ingestion-runs.
 *
 * `byPurpose` / `byProvider` are the same per-bucket tallies emitted on
 * the log line — kept as jsonb so the shape can evolve without a
 * migration. Schema today:
 *   { [purpose]: { calls, inputTokens, outputTokens, costUsd } }
 */
export const ingestionRunsTable = pgTable(
  "ingestion_runs",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    customer: text("customer").notNull(),
    fileName: text("file_name").notNull(),
    weekStart: text("week_start"),
    uploadedBy: integer("uploaded_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    // "success" | "budget_exceeded" | "extraction_failed"
    outcome: text("outcome").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    wallTimeMs: integer("wall_time_ms").notNull().default(0),
    totalCalls: integer("total_calls").notNull().default(0),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalCostUsd: doublePrecision("total_cost_usd").notNull().default(0),
    geminiFallbackUsed: boolean("gemini_fallback_used")
      .notNull()
      .default(false),
    warnedHot: boolean("warned_hot").notNull().default(false),
    byPurpose: jsonb("by_purpose").notNull().default({}),
    byProvider: jsonb("by_provider").notNull().default({}),
    // On a thrown extraction the dispatcher-actionable message; null on success.
    errMsg: text("err_msg"),
  },
  (t) => [
    index("ingestion_runs_created_at_idx").on(t.createdAt),
    index("ingestion_runs_customer_idx").on(t.customer),
    index("ingestion_runs_outcome_idx").on(t.outcome),
  ],
);

export type IngestionRun = typeof ingestionRunsTable.$inferSelect;
