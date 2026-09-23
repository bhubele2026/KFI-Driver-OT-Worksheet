import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import { eq } from "drizzle-orm";
import { db, schema } from "../../lib/db.js";
import { attachAuth, attachUserAndTiles } from "../../lib/entraAuth.js";
import { payrollRouter } from "../payroll.js";

/**
 * Editing a driver's payroll profile (SSN, Zenople ids, pay/bill rates) opened
 * to supervisors in v116 — the pencil on the driver page was admin-only while
 * every other supervisor action on a driver (create, deactivate, tag, timezone,
 * lock, re-shift) was not, and on 2026-09-23 a supervisor had no pencil.
 *
 *   1. A reviewer is refused (403) and no profile row is written.
 *   2. A supervisor's edit lands, and `updated_by` + the audit actor name them
 *      (the stamp that ran null from v89 to v115).
 *
 * Real identity middleware over a memory session, production order;
 * `x-dev-email` is honored outside production. Runs only with DATABASE_URL.
 */

type TestUser = typeof schema.usersTable.$inferSelect;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@profile-permission.test`;
}

async function withUserAndDriver<T>(
  role: "reviewer" | "supervisor",
  fn: (user: TestUser, kfiId: string) => Promise<T>,
): Promise<T> {
  const [u] = await db
    .insert(schema.usersTable)
    .values({ email: uniqueEmail(role), passwordHash: null, isAdmin: false, isActive: true, role })
    .returning();
  const kfiId = `TEST-PROFILE-${u.id}`;
  await db.insert(schema.driversTable).values({
    kfiId,
    name: `Profile Permission Test ${u.id}`,
    customer: "Profile Permission Test",
  });
  try {
    return await fn(u, kfiId);
  } finally {
    await db
      .delete(schema.userAuditLogTable)
      .where(eq(schema.userAuditLogTable.targetEmail, `payroll-profile:${kfiId}`));
    await db
      .delete(schema.driverPayrollProfilesTable)
      .where(eq(schema.driverPayrollProfilesTable.kfiId, kfiId));
    await db.delete(schema.driversTable).where(eq(schema.driversTable.kfiId, kfiId));
    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, u.id));
  }
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "profile-permission-test", resave: false, saveUninitialized: false }));
  app.use(attachAuth);
  app.use(attachUserAndTiles);
  app.use(payrollRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function patchProfile(base: string, kfiId: string, email: string, body: unknown): Promise<Response> {
  return fetch(`${base}/drivers/${encodeURIComponent(kfiId)}/payroll-profile`, {
    method: "PATCH",
    headers: { "x-dev-email": email, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function profileRow(kfiId: string) {
  return db
    .select({
      rtPayRate: schema.driverPayrollProfilesTable.rtPayRate,
      updatedBy: schema.driverPayrollProfilesTable.updatedBy,
    })
    .from(schema.driverPayrollProfilesTable)
    .where(eq(schema.driverPayrollProfilesTable.kfiId, kfiId));
}

test("PATCH /drivers/:kfiId/payroll-profile — a reviewer is refused and nothing is written", async () => {
  await withUserAndDriver("reviewer", async (user, kfiId) => {
    const { url, close } = await startServer();
    try {
      const res = await patchProfile(url, kfiId, user.email, { rtPayRate: 21.5 });
      assert.equal(res.status, 403, "reviewer must not edit a payroll profile");
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "Supervisor or admin access required");
      assert.equal((await profileRow(kfiId)).length, 0, "a refused edit must not create a profile row");
    } finally {
      await close();
    }
  });
});

test("PATCH /drivers/:kfiId/payroll-profile — a supervisor edits, and the edit names them", async () => {
  await withUserAndDriver("supervisor", async (user, kfiId) => {
    const { url, close } = await startServer();
    try {
      const res = await patchProfile(url, kfiId, user.email, { rtPayRate: 21.5 });
      assert.equal(res.status, 200, await res.text().catch(() => ""));

      const [row] = await profileRow(kfiId);
      assert.equal(Number(row?.rtPayRate), 21.5, "the rate must be written");
      assert.equal(row?.updatedBy, user.id, "driver_payroll_profiles.updated_by must name the editor");

      const audit = await db
        .select({
          action: schema.userAuditLogTable.action,
          actorUserId: schema.userAuditLogTable.actorUserId,
        })
        .from(schema.userAuditLogTable)
        .where(eq(schema.userAuditLogTable.targetEmail, `payroll-profile:${kfiId}`));
      assert.deepEqual(
        audit.map((a) => [a.action, a.actorUserId]),
        [["payroll-profile-update", user.id]],
        "user_audit_log must carry the actor",
      );
    } finally {
      await close();
    }
  });
});
