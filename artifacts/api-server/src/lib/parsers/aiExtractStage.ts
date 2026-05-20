import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db.js";
import { logger } from "../logger.js";
import type { AiExtractedRow } from "./aiExtract.js";

/**
 * Per-chunk checkpoint store for resumable AI extracts (Task #309).
 *
 * `runChunkedXlsxExtract` consults a `ChunkStageStore` keyed by an upload
 * identity (`sha256(fileBytes) + ":" + weekStart + ":" + lower(customer)`):
 *
 *  - `load(uploadKey)` — read every staged chunk for this upload before the
 *    first model call so the runner can skip chunks that have already
 *    completed cleanly on a prior attempt.
 *  - `save(...)` — upsert a single chunk's extracted rows immediately
 *    after that chunk's targeted re-issue cycle succeeds.
 *  - `clear(uploadKey)` — delete every staged row for this upload once
 *    the full extract succeeds (no separate "promote" step — the
 *    in-memory merged result IS the promotion).
 *
 * The interface stays minimal and injectable so tests can drive resume
 * scenarios with an in-memory `Map` instead of standing up a database.
 */
export interface ChunkStageStore {
  load(uploadKey: string): Promise<Map<number, AiExtractedRow[]>>;
  save(args: {
    uploadKey: string;
    chunkIndex: number;
    chunkCount: number;
    customer: string;
    weekStart: string;
    fileName: string;
    assignedInputRowIds: number[];
    extractedRows: AiExtractedRow[];
  }): Promise<void>;
  clear(uploadKey: string): Promise<void>;
}

/**
 * Live, DB-backed implementation used by the upload route. Tests usually
 * inject an in-memory store and ignore this one.
 */
export const dbChunkStageStore: ChunkStageStore = {
  async load(uploadKey) {
    const rows = await db
      .select({
        chunkIndex: schema.aiExtractChunkStageTable.chunkIndex,
        extractedRows: schema.aiExtractChunkStageTable.extractedRows,
      })
      .from(schema.aiExtractChunkStageTable)
      .where(eq(schema.aiExtractChunkStageTable.uploadKey, uploadKey));
    const out = new Map<number, AiExtractedRow[]>();
    for (const r of rows) {
      out.set(r.chunkIndex, (r.extractedRows ?? []) as AiExtractedRow[]);
    }
    return out;
  },
  async save(args) {
    await db
      .insert(schema.aiExtractChunkStageTable)
      .values({
        uploadKey: args.uploadKey,
        chunkIndex: args.chunkIndex,
        chunkCount: args.chunkCount,
        customer: args.customer,
        weekStart: args.weekStart,
        fileName: args.fileName,
        assignedInputRowIds: args.assignedInputRowIds,
        extractedRows: args.extractedRows,
      })
      .onConflictDoUpdate({
        target: [
          schema.aiExtractChunkStageTable.uploadKey,
          schema.aiExtractChunkStageTable.chunkIndex,
        ],
        set: {
          chunkCount: args.chunkCount,
          customer: args.customer,
          weekStart: args.weekStart,
          fileName: args.fileName,
          assignedInputRowIds: args.assignedInputRowIds,
          extractedRows: args.extractedRows,
          lastTouchedAt: sql`now()`,
        },
      });
  },
  async clear(uploadKey) {
    await db
      .delete(schema.aiExtractChunkStageTable)
      .where(eq(schema.aiExtractChunkStageTable.uploadKey, uploadKey));
  },
};

/**
 * Stable upload identity used as the staging table's lookup key. Same file
 * bytes + same week + same customer → same key (resume hits). Different
 * file bytes → different key (no cross-upload bleed even if (week, customer)
 * matches).
 */
export function makeUploadKey(args: {
  contentHash: string;
  weekStart: string;
  customer: string;
}): string {
  return `${args.contentHash}:${args.weekStart}:${args.customer.toLowerCase()}`;
}

const STALE_THRESHOLD_DAYS = 7;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delete staging rows whose `lastTouchedAt` is older than the 7-day
 * threshold. Returns the number of rows pruned. Idempotent; safe to call
 * any number of times.
 */
export async function pruneStaleAiExtractChunkStage(): Promise<number> {
  const result = await db
    .delete(schema.aiExtractChunkStageTable)
    .where(
      sql`${schema.aiExtractChunkStageTable.lastTouchedAt} < now() - interval '${sql.raw(
        String(STALE_THRESHOLD_DAYS),
      )} days'`,
    )
    .returning({ id: schema.aiExtractChunkStageTable.id });
  return result.length;
}

/**
 * Boot-time hook: kick the prune once immediately then schedule it every
 * 6 hours so abandoned uploads age out of the staging table within a day
 * of crossing the 7-day threshold. Mirrors `startAiExtractSampleCleanup`.
 */
export function startAiExtractChunkStageCleanup(): NodeJS.Timeout {
  const tick = () => {
    pruneStaleAiExtractChunkStage()
      .then((count) => {
        if (count > 0) {
          logger.info({ count }, "Pruned stale AI extract chunk staging rows");
        }
      })
      .catch((err) => {
        logger.warn({ err }, "AI extract chunk staging cleanup failed");
      });
  };
  void tick();
  const handle = setInterval(tick, CLEANUP_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

/**
 * Aggregate view for `GET /admin/extract-staging`: one row per uploadKey
 * with the chunks-staged counter and last-touched timestamp.
 */
export interface ChunkStageGroup {
  uploadKey: string;
  customer: string;
  weekStart: string;
  fileName: string;
  chunksStaged: number;
  chunkCount: number;
  createdAt: string;
  lastTouchedAt: string;
}

export async function listStagedUploads(
  limit: number,
): Promise<ChunkStageGroup[]> {
  const rows = await db
    .select({
      uploadKey: schema.aiExtractChunkStageTable.uploadKey,
      customer: sql<string>`max(${schema.aiExtractChunkStageTable.customer})`,
      weekStart: sql<string>`max(${schema.aiExtractChunkStageTable.weekStart})`,
      fileName: sql<string>`max(${schema.aiExtractChunkStageTable.fileName})`,
      chunksStaged: sql<number>`count(*)::int`,
      chunkCount: sql<number>`max(${schema.aiExtractChunkStageTable.chunkCount})::int`,
      createdAt: sql<Date>`min(${schema.aiExtractChunkStageTable.createdAt})`,
      lastTouchedAt: sql<Date>`max(${schema.aiExtractChunkStageTable.lastTouchedAt})`,
    })
    .from(schema.aiExtractChunkStageTable)
    .groupBy(schema.aiExtractChunkStageTable.uploadKey)
    .orderBy(desc(sql`max(${schema.aiExtractChunkStageTable.lastTouchedAt})`))
    .limit(limit);
  return rows.map((r) => ({
    uploadKey: r.uploadKey,
    customer: r.customer,
    weekStart: r.weekStart,
    fileName: r.fileName,
    chunksStaged: Number(r.chunksStaged),
    chunkCount: Number(r.chunkCount),
    createdAt: new Date(r.createdAt).toISOString(),
    lastTouchedAt: new Date(r.lastTouchedAt).toISOString(),
  }));
}

