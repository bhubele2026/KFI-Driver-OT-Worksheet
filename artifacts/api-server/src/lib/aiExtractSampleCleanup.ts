import { sql } from "drizzle-orm";
import { db, schema } from "./db.js";
import { logger } from "./logger.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export async function purgeExpiredAiExtractSamples(): Promise<number> {
  const result = await db
    .delete(schema.aiExtractSamplesTable)
    .where(sql`${schema.aiExtractSamplesTable.expiresAt} <= now()`)
    .returning({ id: schema.aiExtractSamplesTable.id });
  return result.length;
}

export function startAiExtractSampleCleanup(): NodeJS.Timeout {
  const tick = () => {
    purgeExpiredAiExtractSamples()
      .then((count) => {
        if (count > 0) {
          logger.info({ count }, "Purged expired AI extract samples");
        }
      })
      .catch((err) => {
        logger.warn({ err }, "AI extract sample cleanup failed");
      });
  };
  void tick();
  const handle = setInterval(tick, CLEANUP_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}
