import { sql } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "@workspace/db/schema";
import { EMBEDDED_MAPPING } from "./mappings.js";
import { logger } from "./logger.js";

/**
 * Task #271: idempotent boot-time migration that seeds every entry from
 * the static `EMBEDDED_MAPPING` dictionary into `driver_id_aliases` so
 * the DB becomes the single source of truth for badge → kfi mappings.
 * `loadMergedIdMap` keeps merging EMBEDDED_MAPPING for one cycle as a
 * safety net; once we've confirmed the seed ran in prod we can delete
 * the source dict in a follow-up.
 *
 * Rows are inserted with `ON CONFLICT DO NOTHING` keyed on the unique
 * `lower(external_id)` index, so re-running on every boot is free and
 * an admin's later override (DB row that points the same badge at a
 * different kfi) is preserved.
 *
 * Skips badges whose mapped kfiId isn't in the active roster — the FK
 * would reject the insert and we don't want to crash boot on stale
 * embedded entries pointing at archived drivers.
 */
export async function seedDriverIdAliasesFromEmbedded(): Promise<{
  inserted: number;
  skipped: number;
}> {
  const driverRows = await db
    .select({ kfiId: schema.driversTable.kfiId })
    .from(schema.driversTable);
  const knownKfi = new Set(driverRows.map((d) => d.kfiId));

  let inserted = 0;
  let skipped = 0;
  for (const [externalId, kfiId] of Object.entries(EMBEDDED_MAPPING)) {
    if (!knownKfi.has(kfiId)) {
      skipped++;
      continue;
    }
    const result = await db.execute(sql`
      INSERT INTO driver_id_aliases (external_id, kfi_id, note)
      VALUES (${externalId}, ${kfiId}, 'seeded from EMBEDDED_MAPPING (Task #271)')
      ON CONFLICT (lower(external_id)) DO NOTHING
    `);
    if ((result as { rowCount?: number }).rowCount === 1) inserted++;
  }
  if (inserted > 0 || skipped > 0) {
    logger.info(
      { inserted, skipped, total: Object.keys(EMBEDDED_MAPPING).length },
      "seedDriverIdAliasesFromEmbedded complete",
    );
  }
  return { inserted, skipped };
}
