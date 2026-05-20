import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.js";
import { fetchAllUsers } from "./connecteam.js";
import { logger } from "./logger.js";
import { recordMutation } from "./dataMutationAudit.js";

/**
 * One-shot, idempotent repair for `drivers.customer` rows that were corrupted
 * by an earlier `String(value)` over a Connecteam dropdown object and ended
 * up as the literal `"[object Object]"`. The Connecteam extractor was already
 * fixed (task #30) and the dashboard now masks this value (task #32 step 1),
 * but we still want the live column to hold the real customer name.
 *
 * On every server boot we look for any rows whose `customer` is the bogus
 * sentinel; when there are none, this is a no-op. When there are some, we
 * re-fetch the Connecteam roster and only overwrite rows whose fresh value
 * is a real (non-sentinel) string.
 *
 * Task #402: the historical fallback that rewrote missing/bogus fresh
 * values to the literal string `"Unknown"` has been removed. A driver who
 * has dropped off the Connecteam roster (turnover, deactivation) gets a
 * warning log with their `kfi_id` and we **leave the row alone** — the
 * silent "Unknown" rewrite was being mistaken for "the time disappeared"
 * by dispatchers because every punch routed through that driver moved
 * into the "Needs roster cleanup" bucket. Operators now find out about
 * an unresolvable driver via this log line, not via missing time on
 * the dashboard.
 */
export async function repairBogusObjectCustomers(): Promise<void> {
  const startedAt = new Date();
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
    await recordMutation({
      routine: "repairBogusObjectCustomers",
      outcome: "error",
      rowsAffected: 0,
      startedAt,
      detail: `scan_failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  if (bogus.length === 0) {
    await recordMutation({
      routine: "repairBogusObjectCustomers",
      outcome: "noop",
      rowsAffected: 0,
      startedAt,
      detail: "no bogus rows",
    });
    return;
  }

  if (!process.env.CONNECTEAM_API_TOKEN) {
    logger.warn(
      { count: bogus.length },
      "repairBogusObjectCustomers: bogus rows present but CONNECTEAM_API_TOKEN unset; skipping",
    );
    await recordMutation({
      routine: "repairBogusObjectCustomers",
      outcome: "noop",
      rowsAffected: 0,
      startedAt,
      detail: `${bogus.length} bogus rows present; CONNECTEAM_API_TOKEN unset`,
    });
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
    await recordMutation({
      routine: "repairBogusObjectCustomers",
      outcome: "error",
      rowsAffected: 0,
      startedAt,
      detail: `roster fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const byKfi = new Map(users.map((u) => [u.kfiId, u.customer]));

  let updated = 0;
  const skippedKfiIds: string[] = [];
  for (const row of bogus) {
    const fresh = byKfi.get(row.kfiId);
    // Task #402: only mutate when we have a real, non-sentinel value to
    // write. Missing-from-roster / still-bogus rows are LEFT ALONE so a
    // driver who disappeared from Connecteam doesn't silently lose their
    // customer association on the dashboard.
    if (!fresh || fresh.trim().toLowerCase() === "[object object]") {
      skippedKfiIds.push(row.kfiId);
      continue;
    }
    updated++;
    await db
      .update(schema.driversTable)
      .set({ customer: fresh, updatedAt: new Date() })
      .where(eq(schema.driversTable.kfiId, row.kfiId));
  }
  if (skippedKfiIds.length > 0) {
    logger.warn(
      { skippedKfiIds, count: skippedKfiIds.length },
      "repairBogusObjectCustomers: leaving rows untouched — fresh Connecteam value missing or bogus (driver may have left the roster)",
    );
  }
  logger.info(
    { scanned: bogus.length, updated, skipped: skippedKfiIds.length },
    "repairBogusObjectCustomers complete",
  );
  await recordMutation({
    routine: "repairBogusObjectCustomers",
    outcome: updated > 0 ? "ok" : "noop",
    rowsAffected: updated,
    startedAt,
    detail: `scanned=${bogus.length} updated=${updated} skipped=${skippedKfiIds.length}${
      skippedKfiIds.length > 0 ? ` skippedKfiIds=${skippedKfiIds.join(",")}` : ""
    }`,
  });
}
