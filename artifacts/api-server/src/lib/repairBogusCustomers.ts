import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.js";
import { fetchAllUsers } from "./connecteam.js";
import { logger } from "./logger.js";

/**
 * One-shot, idempotent repair for `drivers.customer` rows that were corrupted
 * by an earlier `String(value)` over a Connecteam dropdown object and ended
 * up as the literal `"[object Object]"`. The Connecteam extractor was already
 * fixed (task #30) and the dashboard now masks this value (task #32 step 1),
 * but we still want the live column to hold the real customer name.
 *
 * On every server boot we look for any rows whose `customer` is the bogus
 * sentinel; when there are none, this is a no-op. When there are some, we
 * re-fetch the Connecteam roster (which now uses the corrected extractor) and
 * overwrite just those rows.
 */
export async function repairBogusObjectCustomers(): Promise<void> {
  let bogus: { kfiId: string }[];
  try {
    bogus = await db
      .select({ kfiId: schema.driversTable.kfiId })
      .from(schema.driversTable)
      .where(
        sql`lower(trim(${schema.driversTable.customer})) = '[object object]'`,
      );
  } catch (err) {
    logger.warn({ err }, "repairBogusObjectCustomers: scan failed");
    return;
  }
  if (bogus.length === 0) return;

  if (!process.env.CONNECTEAM_API_TOKEN) {
    logger.warn(
      { count: bogus.length },
      "repairBogusObjectCustomers: bogus rows present but CONNECTEAM_API_TOKEN unset; skipping",
    );
    return;
  }

  let users;
  try {
    users = await fetchAllUsers();
  } catch (err) {
    logger.warn(
      { err, count: bogus.length },
      "repairBogusObjectCustomers: Connecteam roster fetch failed; will retry on next boot",
    );
    return;
  }
  const byKfi = new Map(users.map((u) => [u.kfiId, u.customer]));

  let updated = 0;
  let fallback = 0;
  for (const row of bogus) {
    const fresh = byKfi.get(row.kfiId);
    // For drivers no longer in the Connecteam roster (or whose fresh value is
    // somehow still bogus) we fall back to "Unknown" rather than leaving the
    // sentinel in place — the dashboard already buckets "Unknown" into the
    // "Needs roster cleanup" group, so this is the safe neutral state.
    const next =
      fresh && fresh.trim().toLowerCase() !== "[object object]"
        ? fresh
        : "Unknown";
    if (next === "Unknown") fallback++;
    else updated++;
    await db
      .update(schema.driversTable)
      .set({ customer: next, updatedAt: new Date() })
      .where(eq(schema.driversTable.kfiId, row.kfiId));
  }
  logger.info(
    { scanned: bogus.length, updated, fallback },
    "repairBogusObjectCustomers complete",
  );
}
