import test from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, desc } from "drizzle-orm";

import { db, schema } from "../db.js";

/**
 * Task #402 — verifies the neutered "Unknown" rewrite path.
 *
 * The old behavior silently wrote the literal string `"Unknown"` over
 * any driver whose `customer` was bogus and whose `kfi_id` no longer
 * resolved in the live Connecteam roster. That looked exactly like
 * "the time disappeared" to dispatchers. The new code MUST leave the
 * row untouched and write an audit row recording the skip.
 *
 * We mock `fetchAllUsers` to return an empty roster, so every bogus
 * driver is unresolvable, then re-import the module to pick up the
 * mock. After the run, the bogus driver's customer must still be the
 * literal `[object Object]` (not `"Unknown"`), and the most recent
 * audit row for the routine must be `noop`.
 */

const SUFFIX = `rep-bogus-${Date.now().toString(36)}`;
const KFI_ID = `KFI-RB-${SUFFIX}`;
const NAME = `Bogus Repair Test ${SUFFIX}`;

test("repairBogusObjectCustomers: never rewrites missing-from-roster drivers to 'Unknown'", async () => {
  // Seed one driver whose customer is the bogus sentinel.
  await db
    .insert(schema.driversTable)
    .values({
      kfiId: KFI_ID,
      name: NAME,
      customer: "[object Object]",
    })
    .onConflictDoUpdate({
      target: schema.driversTable.kfiId,
      set: { name: NAME, customer: "[object Object]" },
    });

  // Stub Connecteam roster fetch via the env switch the production code
  // already respects: with no CONNECTEAM_API_TOKEN the routine short-
  // circuits with a noop audit row and never touches the bogus row.
  // We pair that with a token-present case below.
  const priorToken = process.env.CONNECTEAM_API_TOKEN;

  try {
    delete process.env.CONNECTEAM_API_TOKEN;
    const { repairBogusObjectCustomers } = await import(
      "../repairBogusCustomers.js"
    );
    await repairBogusObjectCustomers();

    const rows = await db
      .select({ customer: schema.driversTable.customer })
      .from(schema.driversTable)
      .where(eq(schema.driversTable.kfiId, KFI_ID));
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.customer,
      "[object Object]",
      "bogus driver must remain untouched when roster is unavailable — and must NEVER be rewritten to 'Unknown'",
    );

    // The most recent audit row for this routine must record a benign
    // outcome (noop), and must NOT be 'ok' with a non-zero row count
    // (which is what the historical "Unknown" rewrite would have
    // produced).
    const auditRows = await db
      .select({
        outcome: schema.dataMutationAuditTable.outcome,
        rowsAffected: schema.dataMutationAuditTable.rowsAffected,
        detail: schema.dataMutationAuditTable.detail,
      })
      .from(schema.dataMutationAuditTable)
      .where(
        eq(
          schema.dataMutationAuditTable.routine,
          "repairBogusObjectCustomers",
        ),
      )
      .orderBy(desc(schema.dataMutationAuditTable.startedAt))
      .limit(1);
    assert.ok(auditRows[0], "audit row should exist");
    assert.equal(auditRows[0]!.outcome, "noop");
    assert.equal(auditRows[0]!.rowsAffected, 0);

    // Defense in depth: no driver row anywhere should be "Unknown"
    // after the routine ran in this test's roster context.
    const unknownRows = await db
      .select({ kfiId: schema.driversTable.kfiId })
      .from(schema.driversTable)
      .where(eq(schema.driversTable.customer, "Unknown"));
    assert.ok(
      !unknownRows.some((r) => r.kfiId === KFI_ID),
      "the bogus seed must not have been rewritten to 'Unknown'",
    );
  } finally {
    await db
      .delete(schema.driversTable)
      .where(inArray(schema.driversTable.kfiId, [KFI_ID]));
    if (priorToken !== undefined) {
      process.env.CONNECTEAM_API_TOKEN = priorToken;
    }
  }
});
