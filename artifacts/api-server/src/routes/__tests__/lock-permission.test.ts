import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../lib/db.js";
import { attachAuth, attachUserAndTiles } from "../../lib/entraAuth.js";
import { weeksRouter } from "../weeks.js";

/**
 * Locking a driver-week is a ROLE action (`requireSupervisorOrAdmin`), not a
 * tile grant. On 2026-09-23 a person holding the Timesheets tile could not
 * lock and nobody could say why; nothing pinned either half of the rule.
 *
 *   1. A reviewer is refused (403) and nothing is written; a supervisor is not.
 *   2. The lock NAMES who did it. That ran blank from the Entra swap (v89) to
 *      v115: `attachUserAndTiles` set `req.user` but never `req.session.userId`,
 *      which every actor stamp in the routes reads.
 *
 * So this harness mounts the REAL identity middleware over a memory session,
 * in production order — `x-dev-email` is honored outside production — rather
 * than faking `req.user`. Runs only with DATABASE_URL (the heliumdb rig).
 */

const WEEK_START = "2026-01-04";

type TestUser = typeof schema.usersTable.$inferSelect;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@lock-permission.test`;
}

async function withUser<T>(
  role: "reviewer" | "supervisor",
  fn: (user: TestUser, kfiId: string) => Promise<T>,
): Promise<T> {
  const [u] = await db
    .insert(schema.usersTable)
    .values({ email: uniqueEmail(role), passwordHash: null, isAdmin: false, isActive: true, role })
    .returning();
  const kfiId = `TEST-LOCK-${u.id}`;
  try {
    return await fn(u, kfiId);
  } finally {
    await db
      .delete(schema.driverWeekAuditLogTable)
      .where(
        and(
          eq(schema.driverWeekAuditLogTable.weekStart, WEEK_START),
          eq(schema.driverWeekAuditLogTable.kfiId, kfiId),
        ),
      );
    await db
      .delete(schema.reviewedDriversTable)
      .where(
        and(
          eq(schema.reviewedDriversTable.weekStart, WEEK_START),
          eq(schema.reviewedDriversTable.kfiId, kfiId),
        ),
      );
    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, u.id));
  }
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(session({ secret: "lock-permission-test", resave: false, saveUninitialized: false }));
  app.use(attachAuth);
  app.use(attachUserAndTiles);
  app.use(weeksRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function lockUrl(base: string, kfiId: string): string {
  return `${base}/weeks/${WEEK_START}/drivers/${encodeURIComponent(kfiId)}/lock`;
}

async function lockRow(kfiId: string) {
  const rows = await db
    .select({ lockedByUserId: schema.reviewedDriversTable.lockedByUserId })
    .from(schema.reviewedDriversTable)
    .where(
      and(
        eq(schema.reviewedDriversTable.weekStart, WEEK_START),
        eq(schema.reviewedDriversTable.kfiId, kfiId),
      ),
    );
  return rows;
}

test("POST /weeks/:w/drivers/:k/lock — a reviewer is refused and nothing is written", async () => {
  await withUser("reviewer", async (user, kfiId) => {
    const { url, close } = await startServer();
    try {
      const res = await fetch(lockUrl(url, kfiId), {
        method: "POST",
        headers: { "x-dev-email": user.email },
      });
      assert.equal(res.status, 403, "reviewer must not be able to lock");
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "Supervisor or admin access required");
      assert.equal((await lockRow(kfiId)).length, 0, "a refused lock must not touch reviewed_drivers");
    } finally {
      await close();
    }
  });
});

test("POST /weeks/:w/drivers/:k/lock — a supervisor locks, and the lock names them", async () => {
  await withUser("supervisor", async (user, kfiId) => {
    const { url, close } = await startServer();
    try {
      const res = await fetch(lockUrl(url, kfiId), {
        method: "POST",
        headers: { "x-dev-email": user.email },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { locked: boolean; lockedByEmail: string | null };
      assert.equal(body.locked, true);
      assert.equal(
        body.lockedByEmail,
        user.email,
        "the lock must name the person who set it (blank from v89 to v115)",
      );

      const [row] = await lockRow(kfiId);
      assert.equal(row?.lockedByUserId, user.id, "reviewed_drivers.locked_by_user_id");

      const audit = await db
        .select({
          action: schema.driverWeekAuditLogTable.action,
          actorUserId: schema.driverWeekAuditLogTable.actorUserId,
        })
        .from(schema.driverWeekAuditLogTable)
        .where(
          and(
            eq(schema.driverWeekAuditLogTable.weekStart, WEEK_START),
            eq(schema.driverWeekAuditLogTable.kfiId, kfiId),
          ),
        );
      assert.deepEqual(
        audit.map((a) => [a.action, a.actorUserId]),
        [["lock", user.id]],
        "driver_week_audit_log must carry the actor",
      );

      const unlock = await fetch(lockUrl(url, kfiId), {
        method: "DELETE",
        headers: { "x-dev-email": user.email },
      });
      assert.equal(unlock.status, 200);
      const after = (await unlock.json()) as { locked: boolean };
      assert.equal(after.locked, false);
    } finally {
      await close();
    }
  });
});
