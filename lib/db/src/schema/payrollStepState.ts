import {
  pgTable, serial, integer, text, boolean, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/**
 * Per-period state for one checklist step.
 *
 * The step catalogue (`payroll_steps`) is the same every week; this is what
 * changes. Notes deliberately survive into the next period when a step is
 * carried forward, because half of what Tiana tracks is "still waiting on
 * Fontaine", not "done".
 */
export const payrollStepStateTable = pgTable(
  "payroll_step_state",
  {
    id: serial("id").primaryKey(),
    periodId: integer("period_id").notNull(),
    stepId: integer("step_id").notNull(),
    /** pending | in_progress | done | blocked | skipped */
    status: text("status").notNull().default("pending"),
    /** Who it is waiting on — a person, a customer, or a system. */
    blockedOn: text("blocked_on"),
    note: text("note"),
    /** App user id who last moved it. */
    completedBy: integer("completed_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("payroll_step_state_idx").on(t.periodId, t.stepId),
    index("payroll_step_state_period_idx").on(t.periodId),
    index("payroll_step_state_status_idx").on(t.status),
  ],
);

export type PayrollStepState = typeof payrollStepStateTable.$inferSelect;

/**
 * Result of one tie-out run.
 *
 * The six identities are the actual work of the week, so they are first-class
 * rows rather than a pasted pivot snip: they recur all week, they need to be
 * re-runnable, and a failure needs somewhere to say WHAT was off and by how
 * much. `detail` carries the offending rows so the answer is "these four
 * people", not "it does not balance".
 */
export const payrollTieOutsTable = pgTable(
  "payroll_tie_outs",
  {
    id: serial("id").primaryKey(),
    periodId: integer("period_id").notNull(),
    /**
     * pay_vs_bill_units | master_vs_batch | ot_without_40 |
     * fringe_vs_deductions | retro_fringe_vs_offset | tax_vs_register
     */
    tieOut: text("tie_out").notNull(),
    /** pass | fail | not_run */
    status: text("status").notNull().default("not_run"),
    /** Scope of this result: a customer name, or NULL for the whole period. */
    scope: text("scope"),
    expected: text("expected"),
    actual: text("actual"),
    /** Signed difference as text so we never lose precision on the way out. */
    variance: text("variance"),
    /** JSON: the rows that caused the failure. */
    detail: text("detail"),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payroll_tie_outs_period_idx").on(t.periodId),
    uniqueIndex("payroll_tie_outs_unique_idx").on(t.periodId, t.tieOut, t.scope),
  ],
);

export type PayrollTieOut = typeof payrollTieOutsTable.$inferSelect;

/**
 * A file the local bridge saw in a PD folder.
 *
 * The app never owns these files — it inventories them so a tile can say
 * "the fringe import exists and was written at 09:12" without anyone opening
 * Explorer. ⚠️ `Expert Pay/CS Expert Pay PD <d>.csv` carries UNMASKED SSNs and
 * is recorded by name only; its contents are never pushed.
 */
export const payrollArtifactsTable = pgTable(
  "payroll_artifacts",
  {
    id: serial("id").primaryKey(),
    periodId: integer("period_id").notNull(),
    /** Path relative to the PD folder. */
    relPath: text("rel_path").notNull(),
    subfolder: text("subfolder"),
    fileName: text("file_name").notNull(),
    ext: text("ext"),
    sizeBytes: integer("size_bytes"),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    /** What the classifier decided this file is. */
    artifactKind: text("artifact_kind"),
    /** Resolved customer, when the classifier could tell. */
    customerId: integer("customer_id"),
    /** True when the file must never have its contents read into the app. */
    sensitive: boolean("sensitive").notNull().default(false),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payroll_artifacts_path_idx").on(t.periodId, t.relPath),
    index("payroll_artifacts_kind_idx").on(t.artifactKind),
    index("payroll_artifacts_period_idx").on(t.periodId),
  ],
);

export type PayrollArtifact = typeof payrollArtifactsTable.$inferSelect;
