import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../../lib/db.js";
import { weeksRouter } from "../weeks.js";

async function uniqueEmail(prefix: string): Promise<string> {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@lessons-gate.test`;
}

/**
 * ⚠️ These tests assert on the ADMIN GATE, so the harness has to hand the router the same thing
 * production does — and that changed. Identity no longer comes from `req.session`: Easy Auth
 * resolves Entra claims once per request in `attachUserAndTiles`, above every router, and
 * `loadSessionUser` reads `req.user` and nothing else (see src/lib/auth.ts). A harness that sets
 * `req.session = { userId }` is therefore invisible: the gate never sees a user, so every request
 * 401s. Measured 2026-09-03 against a real heliumdb — all THREE failed (401 vs the expected 403,
 * 200 and 400); with the user attached, all three pass.
 *
 * That went unnoticed because this file only runs when DATABASE_URL is set, and nothing set it.
 * Attach the resolved user row, the way the real middleware does.
 */
type TestUser = typeof schema.usersTable.$inferSelect;

async function withTestUser<T>(
  isAdmin: boolean,
  fn: (user: TestUser) => Promise<T>,
): Promise<T> {
  const email = await uniqueEmail(isAdmin ? "admin" : "user");
  const [u] = await db
    .insert(schema.usersTable)
    .values({ email, passwordHash: "x", isAdmin, isActive: true })
    .returning();
  try {
    return await fn(u);
  } finally {
    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, u.id));
  }
}

async function startServerForUser(user: TestUser): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  // Stands in for attachUserAndTiles: the resolved users row, on req.user.
  const fakeEasyAuth: RequestHandler = (req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).user = user;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).session = { userId: user.id }; // some handlers still stamp createdBy from this
    next();
  };
  app.use(fakeEasyAuth);
  app.use(weeksRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("GET /customer-extraction-lessons/:customer is admin-gated (non-admin → 403)", async () => {
  await withTestUser(false, async (user) => {
    const { url, close } = await startServerForUser(user);
    try {
      const res = await fetch(
        `${url}/customer-extraction-lessons/${encodeURIComponent("Some Customer")}`,
      );
      assert.equal(
        res.status,
        403,
        "non-admin must not be able to list extraction lessons",
      );
    } finally {
      await close();
    }
  });
});

test("GET /customer-extraction-lessons/:customer returns 200 with budget envelope for admin", async () => {
  await withTestUser(true, async (admin) => {
    const { url, close } = await startServerForUser(admin);
    try {
      const res = await fetch(
        `${url}/customer-extraction-lessons/${encodeURIComponent("Nonexistent Customer For Test")}`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        lessons: unknown[];
        maxLessonChars: number;
        activeChars: number;
      };
      assert.ok(Array.isArray(body.lessons), "lessons must be an array");
      assert.equal(typeof body.maxLessonChars, "number");
      assert.equal(typeof body.activeChars, "number");
      assert.ok(body.maxLessonChars > 0, "budget cap must be exposed");
    } finally {
      await close();
    }
  });
});

test("GET /customer-extraction-lessons/:customer with empty customer → 400 for admin", async () => {
  await withTestUser(true, async (admin) => {
    const { url, close } = await startServerForUser(admin);
    try {
      const res = await fetch(`${url}/customer-extraction-lessons/${encodeURIComponent("   ")}`);
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
  });
});
