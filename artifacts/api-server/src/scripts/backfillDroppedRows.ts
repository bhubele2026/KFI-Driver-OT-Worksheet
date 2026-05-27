/**
 * Task #434: one-shot backfill of `ai_extract_samples.dropped_rows`.
 *
 * Task #427 added the `dropped_rows` column and started populating it
 * forward — only uploads ingested after that cutover get drop-reason
 * diagnostics in the per-customer chat. This script closes the gap for
 * uploads still in the 90-day retention window by re-running the same
 * parser / AI lane the original upload used against the stashed file
 * bytes, then writing only `dropped_rows` back (NEVER touches
 * `extracted_rows` or `pending_named_rows`).
 *
 * Usage (dev):
 *   pnpm --filter @workspace/api-server run backfill-dropped-rows
 *
 * Safety:
 *   - Idempotent: only processes rows where `dropped_rows IS NULL`
 *     AND `file_bytes` is still present.
 *   - Refuses to run in production unless
 *     `KFI_BACKFILL_DROPPED_ROWS_ALLOW=1` is set in the process env.
 *     "Production" = `REPLIT_DEPLOYMENT=1` OR `NODE_ENV=production`.
 *   - Optional `BACKFILL_LIMIT=N` caps how many rows are touched in
 *     one invocation (default: process all eligible rows).
 *   - The UPDATE re-asserts `dropped_rows IS NULL` so a concurrent
 *     extraction that just landed real diagnostics is not clobbered.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, pool, schema } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { weekEndOf } from "../lib/time.js";
import {
  extractImageForKnownCustomer,
  imageExtension,
} from "../lib/parsers/imageSupport.js";
import { lookupSchema } from "../lib/parsers/schemaLookup.js";
import {
  runCachedPdfRoleReader,
  runCachedRoleReader,
} from "../lib/parsers/runCachedRoleReader.js";
import type { StashedDroppedRow } from "@workspace/db/schema";

const log = logger.child({ scope: "backfillDroppedRows" });

function isProdEnv(): boolean {
  return (
    process.env.REPLIT_DEPLOYMENT === "1" ||
    process.env.NODE_ENV === "production"
  );
}

async function loadIdMap(): Promise<Record<string, string>> {
  const rows = await db
    .select({
      externalId: schema.driverIdAliasesTable.externalId,
      kfiId: schema.driverIdAliasesTable.kfiId,
    })
    .from(schema.driverIdAliasesTable);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.externalId] = r.kfiId;
  return out;
}

async function loadNameAliasMap(customer: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      nameOnDoc: schema.customerNameAliasesTable.nameOnDoc,
      kfiId: schema.customerNameAliasesTable.kfiId,
    })
    .from(schema.customerNameAliasesTable)
    .where(
      sql`lower(${schema.customerNameAliasesTable.customer}) = lower(${customer})`,
    );
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.nameOnDoc.toLowerCase(), r.kfiId);
  return out;
}

async function recomputeDroppedRows(args: {
  sampleId: number;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  customer: string;
  weekStart: string;
  weekEnd: string;
  drivers: Array<{ kfiId: string; name: string; customer: string }>;
  kfiSet: Set<string>;
  idMap: Record<string, string>;
  nameAliasMap: Map<string, string>;
}): Promise<StashedDroppedRow[] | null> {
  const {
    sampleId,
    fileName,
    mimeType,
    buffer,
    customer,
    weekStart,
    weekEnd,
    drivers,
    kfiSet,
    idMap,
    nameAliasMap,
  } = args;
  const isImage = imageExtension(fileName) !== null;

  // Mirror the route: try the schema cache first for non-image files,
  // fall through to AI when there's no cache hit or the cached reader
  // produces nothing useful.
  if (!isImage) {
    try {
      const schemaHit = await lookupSchema(customer, fileName, buffer, false, log);
      if (schemaHit.kind === "cache") {
        const parsed =
          schemaHit.format === "pdf"
            ? await runCachedPdfRoleReader({
                customer,
                buffer,
                schemaHit,
                drivers,
                idMap,
                nameAliasMap,
                weekStart,
                weekEnd,
                log,
              })
            : runCachedRoleReader({
                customer,
                buffer,
                schemaHit,
                drivers,
                idMap,
                nameAliasMap,
                weekStart,
                weekEnd,
                log,
              });
        if (parsed) {
          return (parsed.droppedRows ?? []) as StashedDroppedRow[];
        }
      }
    } catch (err) {
      log.warn(
        { err, sampleId, fileName, customer },
        "cache-lane backfill threw — falling through to AI",
      );
    }
  }

  try {
    const aiResult = await extractImageForKnownCustomer({
      fileName,
      buffer,
      mimeType: mimeType || "application/octet-stream",
      customer,
      weekStart,
      weekEnd,
      idMap,
      drivers,
      kfiSet,
      nameAliasMap,
      log,
    });
    return (aiResult.droppedRows ?? []) as StashedDroppedRow[];
  } catch (err) {
    log.error(
      { err, sampleId, fileName, customer },
      "AI-lane backfill threw — leaving dropped_rows NULL for this sample",
    );
    return null;
  }
}

async function main(): Promise<void> {
  if (isProdEnv() && process.env.KFI_BACKFILL_DROPPED_ROWS_ALLOW !== "1") {
    log.error(
      {
        replitDeployment: process.env.REPLIT_DEPLOYMENT ?? null,
        nodeEnv: process.env.NODE_ENV ?? null,
      },
      "Refusing to run in production without KFI_BACKFILL_DROPPED_ROWS_ALLOW=1",
    );
    process.exitCode = 1;
    return;
  }

  const limitRaw = process.env.BACKFILL_LIMIT;
  const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) : null;

  // Only the columns we need to drive extraction. file_bytes is fetched
  // lazily per-row to avoid pulling every blob into memory up front.
  const candidates = await db
    .select({
      id: schema.aiExtractSamplesTable.id,
      weekStart: schema.aiExtractSamplesTable.weekStart,
      customer: schema.aiExtractSamplesTable.customer,
      fileName: schema.aiExtractSamplesTable.fileName,
      mimeType: schema.aiExtractSamplesTable.mimeType,
      sizeBytes: schema.aiExtractSamplesTable.sizeBytes,
    })
    .from(schema.aiExtractSamplesTable)
    .where(
      and(
        isNull(schema.aiExtractSamplesTable.droppedRows),
        sql`octet_length(${schema.aiExtractSamplesTable.fileBytes}) > 0`,
      ),
    )
    .orderBy(schema.aiExtractSamplesTable.id);

  const todo = limit ? candidates.slice(0, limit) : candidates;
  log.info(
    { eligible: candidates.length, processing: todo.length },
    "Backfill candidates loaded",
  );
  if (todo.length === 0) {
    log.info("Nothing to do — all retained samples already have drop diagnostics");
    return;
  }

  // Roster + id-map are global; load once and reuse across rows.
  const drivers = (
    await db
      .select()
      .from(schema.driversTable)
      .where(eq(schema.driversTable.isArchived, false))
  ).map((d) => ({
    kfiId: d.kfiId,
    name: d.name,
    customer: d.customer ?? "",
  }));
  const kfiSet = new Set(drivers.map((d) => d.kfiId));
  const idMap = await loadIdMap();
  const nameAliasCache = new Map<string, Map<string, string>>();

  let updated = 0;
  let skippedNoBytes = 0;
  let skippedExtractFailed = 0;
  let skippedRaceLost = 0;

  for (const c of todo) {
    const blobRow = await db
      .select({ fileBytes: schema.aiExtractSamplesTable.fileBytes })
      .from(schema.aiExtractSamplesTable)
      .where(eq(schema.aiExtractSamplesTable.id, c.id))
      .limit(1);
    const buffer =
      blobRow[0]?.fileBytes && (blobRow[0].fileBytes as Buffer).length > 0
        ? Buffer.from(blobRow[0].fileBytes as Buffer)
        : null;
    if (!buffer) {
      skippedNoBytes++;
      continue;
    }

    const aliasKey = c.customer.toLowerCase();
    let nameAliasMap = nameAliasCache.get(aliasKey);
    if (!nameAliasMap) {
      nameAliasMap = await loadNameAliasMap(c.customer);
      nameAliasCache.set(aliasKey, nameAliasMap);
    }

    const weekEnd = weekEndOf(c.weekStart);
    const dropped = await recomputeDroppedRows({
      sampleId: c.id,
      fileName: c.fileName,
      mimeType: c.mimeType,
      buffer,
      customer: c.customer,
      weekStart: c.weekStart,
      weekEnd,
      drivers,
      kfiSet,
      idMap,
      nameAliasMap,
    });
    if (dropped === null) {
      skippedExtractFailed++;
      continue;
    }

    // Re-assert `dropped_rows IS NULL` in the WHERE so a concurrent
    // extraction (or a second invocation of this script) that already
    // wrote real diagnostics for this row is not overwritten.
    const result = await db
      .update(schema.aiExtractSamplesTable)
      .set({ droppedRows: dropped })
      .where(
        and(
          eq(schema.aiExtractSamplesTable.id, c.id),
          isNull(schema.aiExtractSamplesTable.droppedRows),
        ),
      )
      .returning({ id: schema.aiExtractSamplesTable.id });
    if (result.length === 0) {
      skippedRaceLost++;
      log.info(
        { sampleId: c.id, customer: c.customer, fileName: c.fileName },
        "dropped_rows already populated by another writer — skipping",
      );
      continue;
    }
    updated++;
    log.info(
      {
        sampleId: c.id,
        customer: c.customer,
        fileName: c.fileName,
        droppedCount: dropped.length,
      },
      "Backfilled dropped_rows",
    );
  }

  log.info(
    {
      updated,
      skippedNoBytes,
      skippedExtractFailed,
      skippedRaceLost,
      total: todo.length,
    },
    "Backfill complete",
  );
}

main()
  .catch((err) => {
    log.error({ err }, "Backfill failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
