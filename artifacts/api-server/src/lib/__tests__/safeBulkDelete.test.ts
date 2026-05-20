import test from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "../db.js";
import {
  safeBulkDelete,
  BULK_DELETE_OPT_IN_ENV,
} from "../safeBulkDelete.js";

/**
 * Task #402 — covers the production fail-safe for any boot-time bulk delete.
 *
 * Seeds rows in `rate_limit_buckets` (a throw-away table with a TEXT PK,
 * safe to fill with synthetic markers) and exercises the three branches
 * of the guard: under-threshold runs normally, over-threshold refuses
 * in production, over-threshold is allowed when the opt-in env is set.
 * Every branch must leave a `data_mutation_audit` row keyed to the
 * test's unique routine name.
 */

const ROUTINE_BASE = `safeBulkDelete-test-${Date.now().toString(36)}`;

const LIMITER_NAME = "sbd-test";

async function seedBuckets(tag: string, count: number): Promise<string[]> {
  const keys = Array.from({ length: count }, (_, i) => `${tag}-${i}`);
  const reset = new Date(Date.now() + 60_000);
  await db
    .insert(schema.rateLimitBucketsTable)
    .values(
      keys.map((key) => ({
        name: LIMITER_NAME,
        key,
        resetAt: reset,
        count: 1,
      })),
    )
    .onConflictDoNothing();
  return keys;
}

async function cleanupBuckets(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db
    .delete(schema.rateLimitBucketsTable)
    .where(
      and(
        eq(schema.rateLimitBucketsTable.name, LIMITER_NAME),
        inArray(schema.rateLimitBucketsTable.key, keys),
      ),
    );
}

async function latestAuditRow(routine: string) {
  const rows = await db
    .select()
    .from(schema.dataMutationAuditTable)
    .where(eq(schema.dataMutationAuditTable.routine, routine))
    .orderBy(desc(schema.dataMutationAuditTable.startedAt))
    .limit(1);
  return rows[0];
}

async function clearAudit(routine: string) {
  await db
    .delete(schema.dataMutationAuditTable)
    .where(eq(schema.dataMutationAuditTable.routine, routine));
}

function withEnv<T extends Record<string, string | undefined>>(
  overrides: T,
  fn: () => Promise<void>,
): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) prior[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("safeBulkDelete: under-threshold delete runs and audits ok", async () => {
  const routine = `${ROUTINE_BASE}-under`;
  const tag = `sbd-under-${Date.now().toString(36)}`;
  const keys = await seedBuckets(tag, 3);
  try {
    await withEnv(
      { NODE_ENV: "production", [BULK_DELETE_OPT_IN_ENV]: undefined },
      async () => {
        const res = await safeBulkDelete({
          routine,
          tableLabel: "rate_limit_buckets",
          table: schema.rateLimitBucketsTable,
          where: sql`${schema.rateLimitBucketsTable.name} = ${LIMITER_NAME} AND ${schema.rateLimitBucketsTable.key} LIKE ${`${tag}-%`}`,
          threshold: 5,
        });
        assert.equal(res.outcome, "ok");
        assert.equal(res.matched, 3);
        assert.equal(res.deleted, 3);
      },
    );
    const audit = await latestAuditRow(routine);
    assert.ok(audit, "audit row exists");
    assert.equal(audit!.outcome, "ok");
    assert.equal(audit!.rowsAffected, 3);
  } finally {
    await cleanupBuckets(keys);
    await clearAudit(routine);
  }
});

test("safeBulkDelete: over-threshold refuses in production and audits refused", async () => {
  const routine = `${ROUTINE_BASE}-refused`;
  const tag = `sbd-refused-${Date.now().toString(36)}`;
  const keys = await seedBuckets(tag, 7);
  try {
    await withEnv(
      { NODE_ENV: "production", [BULK_DELETE_OPT_IN_ENV]: undefined },
      async () => {
        const res = await safeBulkDelete({
          routine,
          tableLabel: "rate_limit_buckets",
          table: schema.rateLimitBucketsTable,
          where: sql`${schema.rateLimitBucketsTable.name} = ${LIMITER_NAME} AND ${schema.rateLimitBucketsTable.key} LIKE ${`${tag}-%`}`,
          threshold: 5,
        });
        assert.equal(res.outcome, "refused");
        assert.equal(res.matched, 7);
        assert.equal(res.deleted, 0);
      },
    );
    // Survivors untouched.
    const survivors = await db
      .select({ key: schema.rateLimitBucketsTable.key })
      .from(schema.rateLimitBucketsTable)
      .where(inArray(schema.rateLimitBucketsTable.key, keys));
    assert.equal(survivors.length, 7, "refusal must not delete any rows");
    const audit = await latestAuditRow(routine);
    assert.ok(audit, "audit row exists");
    assert.equal(audit!.outcome, "refused");
    assert.equal(audit!.rowsAffected, 0);
  } finally {
    await cleanupBuckets(keys);
    await clearAudit(routine);
  }
});

test("safeBulkDelete: opt-in env bypasses the production guard", async () => {
  const routine = `${ROUTINE_BASE}-optin`;
  const tag = `sbd-optin-${Date.now().toString(36)}`;
  const keys = await seedBuckets(tag, 7);
  try {
    await withEnv(
      { NODE_ENV: "production", [BULK_DELETE_OPT_IN_ENV]: "1" },
      async () => {
        const res = await safeBulkDelete({
          routine,
          tableLabel: "rate_limit_buckets",
          table: schema.rateLimitBucketsTable,
          where: sql`${schema.rateLimitBucketsTable.name} = ${LIMITER_NAME} AND ${schema.rateLimitBucketsTable.key} LIKE ${`${tag}-%`}`,
          threshold: 5,
        });
        assert.equal(res.outcome, "ok");
        assert.equal(res.matched, 7);
        assert.equal(res.deleted, 7);
      },
    );
    const audit = await latestAuditRow(routine);
    assert.ok(audit, "audit row exists");
    assert.equal(audit!.outcome, "ok");
    assert.equal(audit!.rowsAffected, 7);
  } finally {
    await cleanupBuckets(keys);
    await clearAudit(routine);
  }
});

test("safeBulkDelete: zero-match writes a noop audit row and does nothing", async () => {
  const routine = `${ROUTINE_BASE}-noop`;
  const tag = `sbd-noop-${Date.now().toString(36)}`;
  try {
    await withEnv(
      { NODE_ENV: "production", [BULK_DELETE_OPT_IN_ENV]: undefined },
      async () => {
        const res = await safeBulkDelete({
          routine,
          tableLabel: "rate_limit_buckets",
          table: schema.rateLimitBucketsTable,
          where: sql`${schema.rateLimitBucketsTable.name} = ${LIMITER_NAME} AND ${schema.rateLimitBucketsTable.key} LIKE ${`${tag}-nomatch-%`}`,
          threshold: 5,
        });
        assert.equal(res.outcome, "noop");
        assert.equal(res.matched, 0);
        assert.equal(res.deleted, 0);
      },
    );
    const audit = await latestAuditRow(routine);
    assert.ok(audit, "audit row exists");
    assert.equal(audit!.outcome, "noop");
  } finally {
    await clearAudit(routine);
  }
});
