import {
  pgTable, serial, integer, text, numeric, boolean, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/**
 * One ACTION that must be keyed into Zenople before the pay date.
 *
 * This is the `to do this payroll` ledger, modelled properly. The rule that
 * shapes it: **one row per action, not per email**. Three people named in one
 * transportation table are three rows; a thread corrected four times is one row
 * carrying the final number and what it replaced.
 */
export const payrollChangesTable = pgTable(
  "payroll_changes",
  {
    id: serial("id").primaryKey(),
    periodId: integer("period_id").notNull(),

    /**
     * Idempotency key: sha1 of conversation + person + type + week ending.
     * A re-sweep must UPDATE this row, never add a second one — and must carry
     * the human's own edits forward, because a rebuild that wipes a processor's
     * check-offs is worse than no tool at all.
     */
    rowKey: text("row_key").notNull(),

    customer: text("customer"),
    customerId: integer("customer_id"),
    /** "Multiple" is a legitimate value the ledger uses. */
    employee: text("employee"),
    personId: integer("person_id"),
    /** How many people this row covers — the verification counts key off it. */
    peopleCount: integer("people_count").notNull().default(1),

    /** PAS | TMS | 2TMS — where in Zenople it lands, and when. */
    route: text("route"),
    /** Canonical type from the taxonomy. */
    changeType: text("change_type").notNull(),
    /** Exactly what was typed or inferred, before normalising. */
    changeTypeRaw: text("change_type_raw"),

    amount: numeric("amount", { precision: 12, scale: 2 }),
    hours: numeric("hours", { precision: 8, scale: 2 }),
    /** Week ending this applies to — retro rows differ from the current week. */
    weekEnding: text("week_ending"),
    effectiveDate: text("effective_date"),
    /** True when this belongs to a PRIOR week and must be entered as retro. */
    isRetro: boolean("is_retro").notNull().default(false),

    /** Imperative: "Enter 10.00 hrs MN-ESST", not "sick time request". */
    action: text("action").notNull(),
    /** What the final number replaced, and why. Blank when nothing changed. */
    supersedes: text("supersedes"),
    /**
     * ⚠️ The other half of a paired entry. Terrell is +2.00 Driver OT AND
     * -0.50 Retro Driver RT; entering the positive alone overpays. Rows that
     * name each other are rendered together and can never be actioned singly.
     */
    pairedWithRowKey: text("paired_with_row_key"),

    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    /** Tiana's own Outlook category — her taxonomy, not an invented one. */
    category: text("category"),
    sourceKind: text("source_kind").notNull().default("email"),
    sourceRef: text("source_ref"),
    conversationId: text("conversation_id"),
    /**
     * Graph id of THE message that drove this row. The conversationId above is
     * only the thread — a corrected thread has many messages, and the
     * Create-PDF flow needs to file the exact one.
     */
    sourceMessageId: text("source_message_id"),
    sourceReceivedAt: timestamp("source_received_at", { withTimezone: true }),

    /**
     * The four verification columns, as COUNTS not booleans — the ledger writes
     * one x per person on a multi-person row. -1 means "n/a".
     */
    enteredZenople: integer("entered_zenople").notNull().default(0),
    verifiedTs: integer("verified_ts").notNull().default(0),
    verifiedPas: integer("verified_pas").notNull().default(0),
    documentationSaved: integer("documentation_saved").notNull().default(0),

    /** Free text the processor owns. A re-sweep must never clobber this. */
    notes: text("notes"),
    /** Generated per the Documentation/ naming formula. */
    fileNaming: text("file_naming"),

    /**
     * Create-PDF lifecycle: a processor asks for the source email as a PDF in
     * the SharePoint `New PDF` folder; the Mac-side executor fulfils it and
     * reports back. null = never asked; requested → filed | failed.
     * ⚠️ Owned by the button and the executor, like `notes` is owned by the
     * human — the sweep upsert must never list these in its set block.
     */
    pdfStatus: text("pdf_status"),
    pdfRequestedBy: text("pdf_requested_by"),
    pdfRequestedAt: timestamp("pdf_requested_at", { withTimezone: true }),
    pdfFiledAt: timestamp("pdf_filed_at", { withTimezone: true }),
    pdfWebUrl: text("pdf_web_url"),
    pdfError: text("pdf_error"),

    /**
     * A discussed intent is NOT an approval. Anything still a question lands
     * here and is kept off the action list entirely.
     */
    needsDecision: boolean("needs_decision").notNull().default(false),
    decisionQuestion: text("decision_question"),
    decisionOwner: text("decision_owner"),

    /** new | changed | unchanged since the last sweep — shown, not guessed. */
    sweepState: text("sweep_state").notNull().default("new"),
    lastSweptAt: timestamp("last_swept_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("payroll_changes_row_key_idx").on(t.periodId, t.rowKey),
    index("payroll_changes_period_idx").on(t.periodId),
    index("payroll_changes_type_idx").on(t.changeType),
    index("payroll_changes_decision_idx").on(t.needsDecision),
    index("payroll_changes_conversation_idx").on(t.conversationId),
    // The executor polls for pdf_status = 'requested' every 15 minutes.
    index("payroll_changes_pdf_status_idx").on(t.pdfStatus),
  ],
);

export type PayrollChange = typeof payrollChangesTable.$inferSelect;

/**
 * A message the sweep saw, so a row can be traced back to its source and a
 * re-sweep can tell what is genuinely new.
 */
export const payrollChangeSourcesTable = pgTable(
  "payroll_change_sources",
  {
    id: serial("id").primaryKey(),
    periodId: integer("period_id").notNull(),
    messageId: text("message_id").notNull(),
    conversationId: text("conversation_id"),
    subject: text("subject"),
    sender: text("sender"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    categories: text("categories").array(),
    attachmentNames: text("attachment_names").array(),
    /** Which rows this message drives, by rowKey. */
    drivesRowKeys: text("drives_row_keys").array(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payroll_change_sources_msg_idx").on(t.periodId, t.messageId),
    index("payroll_change_sources_period_idx").on(t.periodId),
  ],
);

export type PayrollChangeSource = typeof payrollChangeSourcesTable.$inferSelect;

/**
 * Durable store for the Changes board's terse row labels.
 *
 * ⚠️ WHY THIS TABLE EXISTS. The summaries used to live only in an in-process
 * `Map`, and the board's GET blocked up to 3.5s waiting for a cold one to fill
 * — then returned the rows with NO summaries anyway. Every deploy wiped the
 * Map, so that 3.5s came back on every period, forever. Measured 2026-09-03:
 * cold load 3,594ms / 0 summaries, next load 52ms / all 12. The wait bought
 * the user nothing.
 *
 * Keyed on sha1(action) — the TEXT, not the row — which matches the cache
 * semantics it replaces and means a recurring deduction worded identically is
 * summarized once for ALL periods, not once per period.
 *
 * Only FAITHFUL summaries are stored (see summaryIsFaithful). A row whose
 * summary flunked the digit/negation check is remembered in-process only:
 * persisting that refusal would suppress the row forever, including after a
 * better model ships.
 */
export const payrollChangeSummaryTable = pgTable("payroll_change_summary", {
  /** sha1 of the action text — the same keyFor() the in-process cache uses. */
  actionHash: text("action_hash").primaryKey(),
  summary: text("summary").notNull(),
  /** Which model wrote it, so a model change can be invalidated deliberately. */
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PayrollChangeSummary = typeof payrollChangeSummaryTable.$inferSelect;
