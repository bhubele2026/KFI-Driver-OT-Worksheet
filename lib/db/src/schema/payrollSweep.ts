import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/**
 * One run of the mailbox sweep — nightly or from the board's button.
 *
 * ⚠️ WHY THIS CARRIES A CLAIM, NOT JUST A STATUS. The Create-PDF flow tracks
 * its work in a single `pdf_status` column with no lease, no attempt counter
 * and no claimed-at. An executor killed mid-run therefore left PDFs
 * filed-but-unreported: the side effect had happened, the row still said
 * `requested`, and a re-run minted " (2)" duplicates. A sweep has the same
 * shape of hazard — it can post rows and then die before recording that it
 * did — so the run row is claimed BEFORE any work and stamped after, and a
 * run left `running` past its lease is visibly stale rather than invisible.
 */
export const payrollSweepRunsTable = pgTable(
  "payroll_sweep_runs",
  {
    id: serial("id").primaryKey(),
    /** "nightly" | "manual" */
    trigger: text("trigger").notNull(),
    /** Email of whoever pressed the button; null for the nightly run. */
    triggeredBy: text("triggered_by"),
    /** Inclusive ISO instant the mail window starts at. */
    windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
    /** Exclusive ISO instant the mail window ends at. */
    windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
    /** "running" | "ok" | "failed" | "skipped" */
    status: text("status").notNull().default("running"),
    /** Why a run did nothing — "another replica is sweeping", "not configured". */
    skippedReason: text("skipped_reason"),
    /**
     * Counts, as jsonb so the shape can grow without a migration:
     * { headers, deduped, prefiltered, triaged, classified, posted,
     *   queued, periods: {<payDate>: {created, changed, carried}} }
     */
    counts: jsonb("counts").notNull().default({}),
    /** Dispatcher-readable failure. Null on success. */
    errMsg: text("err_msg"),
    /** True when the run classified but deliberately wrote nothing. */
    dryRun: boolean("dry_run").notNull().default(false),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payroll_sweep_runs_created_idx").on(t.createdAt),
    index("payroll_sweep_runs_status_idx").on(t.status),
  ],
);

export type PayrollSweepRun = typeof payrollSweepRunsTable.$inferSelect;

/**
 * A row the sweep produced but would not post on its own authority.
 *
 * Two things land here, and they are different in kind:
 *  - `unverified` — a number in the row could not be found verbatim in the
 *    source email, so the model may have invented or reformatted it.
 *  - `would_change_verified` — the row is fine, but posting it would move a
 *    MATERIAL field on a row a human has already ticked. The merge protects
 *    her check-offs; it does not protect her CONFIDENCE in the number she
 *    checked. Silently changing it is the worse failure.
 */
export const payrollSweepProposalsTable = pgTable(
  "payroll_sweep_proposals",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull(),
    periodId: integer("period_id"),
    payDate: text("pay_date").notNull(),
    rowKey: text("row_key").notNull(),
    /** The full candidate SweptRow, exactly as it would have been written. */
    row: jsonb("row").notNull(),
    /** "unverified" | "would_change_verified" | "no_route" | "unknown_type" */
    reason: text("reason").notNull(),
    /** Human-readable detail: which token was missing, which field would move. */
    detail: text("detail"),
    /** Employee/customer/action lifted out so a list renders without parsing jsonb. */
    employee: text("employee"),
    customer: text("customer"),
    action: text("action"),
    /** "pending" | "accepted" | "rejected" */
    state: text("state").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A re-sweep that reaches the same verdict must update its proposal, not
    // stack a second identical one in front of the reviewer every night.
    uniqueIndex("payroll_sweep_proposals_key_idx").on(t.payDate, t.rowKey),
    index("payroll_sweep_proposals_state_idx").on(t.state),
    index("payroll_sweep_proposals_run_idx").on(t.runId),
  ],
);

export type PayrollSweepProposal = typeof payrollSweepProposalsTable.$inferSelect;

/**
 * Every message the sweep has already read, so a nightly run re-classifies
 * only what actually changed.
 *
 * ⚠️ Keyed on `internet_message_id`, NOT the Graph id. Graph ids are per-folder
 * and change when a message is filed — Tiana files payroll mail into the PD
 * subfolders while the sweep is running, and five messages went NOT_FOUND
 * mid-run on 2026-09-16 for exactly that reason. The internet message id is
 * the one identifier that survives a move.
 *
 * `payroll_change_sources` cannot serve as this watermark: it is scoped to a
 * period, so a message read for one period looks unseen to another.
 */
export const payrollSweepSeenMessagesTable = pgTable(
  "payroll_sweep_seen_messages",
  {
    id: serial("id").primaryKey(),
    internetMessageId: text("internet_message_id").notNull(),
    /** Most recent Graph id seen for it — advisory only, it moves. */
    graphMessageId: text("graph_message_id"),
    conversationId: text("conversation_id"),
    subject: text("subject"),
    sender: text("sender"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    /** sha1 of the body text — a re-send or an edit re-opens classification. */
    bodyHash: text("body_hash"),
    /** What the prefilter/triage decided: "skip" | "candidate" | "classified". */
    verdict: text("verdict").notNull(),
    /** Why it was skipped, for the run log. */
    verdictReason: text("verdict_reason"),
    /** How many action rows it produced (0 is a real, useful answer). */
    rowsProduced: integer("rows_produced").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payroll_sweep_seen_msg_idx").on(t.internetMessageId),
    index("payroll_sweep_seen_received_idx").on(t.receivedAt),
  ],
);

export type PayrollSweepSeenMessage = typeof payrollSweepSeenMessagesTable.$inferSelect;
