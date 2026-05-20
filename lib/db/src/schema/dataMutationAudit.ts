import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-routine, per-boot audit trail of every data-mutating routine the
 * API server runs at startup (Task #402). One row is written **every**
 * time a routine completes — including the zero-rows "no-op" case — so
 * an operator can confirm a fresh republish was a clean boot at a glance.
 *
 * Routines that audit here today:
 *   - repairBogusObjectCustomers
 *   - deleteLegacyParserSchemaRows
 *   - seedDriverPayrollProfiles
 *   - safeBulkDelete (any call site that opts into the bulk-delete guard)
 *
 * The matching admin view at /admin/boot-audit surfaces the latest 50
 * rows newest-first so the next "the time disappeared" incident is
 * traceable to the row that did it (or, much more usefully, provable
 * to NOT correspond to any row at all).
 */
export const dataMutationAuditTable = pgTable(
  "data_mutation_audit",
  {
    id: serial("id").primaryKey(),
    routine: text("routine").notNull(),
    // "noop" | "ok" | "refused" | "error". `refused` is the bulk-delete
    // guard tripping in production; `error` means the routine threw.
    outcome: text("outcome").notNull(),
    rowsAffected: integer("rows_affected").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // REPLIT_DEPLOYMENT_ID at process start time (null in dev / e2e).
    deploymentId: text("deployment_id"),
    // REPLIT_GIT_COMMIT or process.env.GIT_SHA if either is set; null otherwise.
    gitSha: text("git_sha"),
    // NODE_ENV at process start (so a single audit table covers dev + prod).
    nodeEnv: text("node_env"),
    // Free-form per-routine context: the routine name, table touched, any
    // structured payload the routine wants to keep on the row. Kept as
    // plain text so the row stays cheap and grep-friendly.
    detail: text("detail"),
  },
  (t) => [
    index("data_mutation_audit_started_at_idx").on(t.startedAt),
    index("data_mutation_audit_routine_idx").on(t.routine),
  ],
);

export type DataMutationAudit = typeof dataMutationAuditTable.$inferSelect;
