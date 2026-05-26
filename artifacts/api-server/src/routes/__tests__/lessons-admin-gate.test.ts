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

async function withTestUser<T>(
  isAdmin: boolean,
  fn: (userId: number) => Promise<T>,
): Promise<T> {
  const email = await uniqueEmail(isAdmin ? "admin" : "user");
  const [u] = await db
    .insert(schema.usersTable)
    .values({ email, passwordHash: "x", isAdmin, isActive: true })
    .returning();
  try {
    return await fn(u.id);
  } finally {
    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, u.id));
  }
}

async function startServerForUser(userId: number): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  const fakeSession: RequestHandler = (req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).session = { userId };
    next();
  };
  app.use(fakeSession);
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
  await withTestUser(false, async (userId) => {
    const { url, close } = await startServerForUser(userId);
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
  await withTestUser(true, async (adminId) => {
    const { url, close } = await startServerForUser(adminId);
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
  await withTestUser(true, async (adminId) => {
    const { url, close } = await startServerForUser(adminId);
    try {
      const res = await fetch(`${url}/customer-extraction-lessons/${encodeURIComponent("   ")}`);
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
  });
});
