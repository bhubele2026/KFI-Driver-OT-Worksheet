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
    /**
     * Task #314: total ms spent inside `TokenPacer.acquire()` across
     * every chunk of this upload. Near-zero on uncontended uploads;
     * dominates `wallTimeMs` when concurrent uploads collectively bump
     * against Anthropic's per-minute TPM ceiling, telling the operator
     * the upload was pacer-bound rather than model-bound.
     */
    pacerWaitMs: integer("pacer_wait_ms").notNull().default(0),
    geminiFallbackUsed: boolean("gemini_fallback_used")
      .notNull()
      .default(false),
    warnedHot: boolean("warned_hot").notNull().default(false),
    byPurpose: jsonb("by_purpose").notNull().default({}),
    byProvider: jsonb("by_provider").notNull().default({}),
    // On a thrown extraction the dispatcher-actionable message; null on success.
    errMsg: text("err_msg"),
    // Task #307: xlsx layout the chunker saw at extract time. True for
    // "block-structured" customer files (header band repeats per
    // driver, e.g. Adient) where the per-chunk row cap is halved so
    // Claude doesn't truncate. Null for non-xlsx uploads (image / pdf
    // / single-call paths don't chunk by rows).
    blockStructured: boolean("block_structured"),
    rowsPerChunk: integer("rows_per_chunk"),
    /**
     * Task #310: true when the upload short-circuited via the
     * `customer_column_schemas` recipe cache and made zero model
     * calls. Lets the operator compute the "pay once" hit rate
     * straight off this table:
     *   `SELECT recipe_cache_hit, COUNT(*) FROM ingestion_runs
     *      WHERE created_at > now() - interval '7 days'
     *      GROUP BY 1;`
     * Cache-hit rows still get written so the audit trail covers
     * every per-row upload, not just the AI-touched ones.
     */
    recipeCacheHit: boolean("recipe_cache_hit").notNull().default(false),
  },
  (t) => [
    index("ingestion_runs_created_at_idx").on(t.createdAt),
    index("ingestion_runs_customer_idx").on(t.customer),
    index("ingestion_runs_outcome_idx").on(t.outcome),
  ],
);

export type IngestionRun = typeof ingestionRunsTable.$inferSelect;
