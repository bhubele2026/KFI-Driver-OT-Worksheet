import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-chunk checkpoint table for resumable AI customer-file extracts (Task #309).
 *
 * A first-contact 10k-row upload can take 10+ minutes and dispatches dozens
 * of chunked Claude calls. If chunk 47 of 70 fails (network blip, rate
 * limit, parse error), without checkpointing the dispatcher re-uploads the
 * file and we pay Anthropic for chunks 1..46 again. This table persists
 * each successfully extracted chunk's rows keyed by an upload identity
 * (`sha256(fileBytes) + weekStart + customer`) so the same bytes re-uploaded
 * for the same (week, customer) skip already-completed chunks and only
 * issue Claude calls for the missing ones.
 *
 * Lifecycle:
 *  - WRITE: `runChunkedXlsxExtract` upserts one row per chunk immediately
 *    after that chunk's targeted re-issue cycle completes cleanly.
 *  - READ: at the start of the next extract for the same `uploadKey`, the
 *    runner loads every staged chunk and short-circuits the model call for
 *    each `(uploadKey, chunkIndex)` hit.
 *  - PROMOTE + CLEAR: on full success, the runner deletes every staging
 *    row for that `uploadKey` in a single statement (no separate
 *    "promote" step — the in-memory merged result IS the promotion).
 *  - PRUNE: a periodic job (`startAiExtractChunkStageCleanup`) deletes
 *    rows whose `lastTouchedAt` is older than 7 days.
 *  - DISCARD: `DELETE /admin/extract-staging/:uploadKey` lets an operator
 *    explicitly drop a hung run from the staging table.
 *
 * `assignedInputRowIds` mirrors the per-chunk `[R<n>]` IDs the chunker
 * assigned (`body.map((_, i) => i + 1)`), kept as an audit trail in case
 * future chunker tweaks change the row-per-chunk shape and we need to
 * detect mismatched checkpoints (today: same buffer → same chunks, so a
 * pure `(uploadKey, chunkIndex)` lookup is correct).
 */
export const aiExtractChunkStageTable = pgTable(
  "ai_extract_chunk_stage",
  {
    id: serial("id").primaryKey(),
    /** sha256(fileBytes) + ":" + weekStart + ":" + lower(customer). */
    uploadKey: text("upload_key").notNull(),
    /** Zero-based chunk position within `chunks[]`. */
    chunkIndex: integer("chunk_index").notNull(),
    /** Total chunks the chunker produced for this upload. */
    chunkCount: integer("chunk_count").notNull(),
    /** Canonical customer display name (matches `punches.customer`). */
    customer: text("customer").notNull(),
    /** Sunday-anchored payroll week start (YYYY-MM-DD). */
    weekStart: text("week_start").notNull(),
    /** Original filename — surfaced in the admin list for operator context. */
    fileName: text("file_name").notNull(),
    /** Per-chunk `[R<n>]` IDs the chunker assigned (audit trail). */
    assignedInputRowIds: jsonb("assigned_input_row_ids").notNull(),
    /** The post-resolution `AiExtractedRow[]` the model returned for this chunk. */
    extractedRows: jsonb("extracted_rows").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Bumped on every upsert so the 7-day prune job has a stable clock. */
    lastTouchedAt: timestamp("last_touched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_extract_chunk_stage_uq").on(t.uploadKey, t.chunkIndex),
    index("ai_extract_chunk_stage_last_touched_idx").on(t.lastTouchedAt),
    index("ai_extract_chunk_stage_upload_key_idx").on(t.uploadKey),
  ],
);

export type AiExtractChunkStageRow =
  typeof aiExtractChunkStageTable.$inferSelect;
