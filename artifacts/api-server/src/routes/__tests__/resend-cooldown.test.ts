import test from "node:test";
import assert from "node:assert/strict";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "../../lib/db.js";

// These tests exercise the *atomic* cooldown gate that
// /auth/invites/:token/resend and /auth/users/:id/send-password-reset
// rely on to stop double-clicked admin actions from emailing the
// recipient (and minting fresh reset tokens) multiple times.
//
// We execute the same conditional UPDATE the route does, in parallel,
// and assert that exactly one wins. If two ever win, the cooldown is
// race-prone and the original task's bug is back.

const COOLDOWN_MS = 60 * 1000;
const PARALLEL = 8;

async function uniqueEmail(prefix: string): Promise<string> {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@cooldown.test`;
}

async function withTestUser<T>(fn: (userId: number) => Promise<T>): Promise<T> {
  const email = await uniqueEmail("user");
  const [u] = await db
    .insert(schema.usersTable)
    .values({ email, passwordHash: "x", isAdmin: false, isActive: true })
    .returning();
  try {
    return await fn(u.id);
  } finally {
    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, u.id));
  }
}

async function withTestInvite<T>(
  createdByUserId: number,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const email = await uniqueEmail("invite");
  const token = `tok-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  await db.insert(schema.invitesTable).values({
    email,
    token,
    createdByUserId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  try {
    return await fn(token);
  } finally {
    await db.delete(schema.invitesTable).where(eq(schema.invitesTable.token, token));
  }
}

test("invite resend cooldown: only one of N concurrent claims wins", async () => {
  await withTestUser(async (adminId) => {
    await withTestInvite(adminId, async (token) => {
      const now = new Date();
      const cooldownStart = new Date(now.getTime() - COOLDOWN_MS);

      const claims = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          db
            .update(schema.invitesTable)
            .set({ lastSentAt: new Date() })
            .where(
              and(
                eq(schema.invitesTable.token, token),
                isNull(schema.invitesTable.usedAt),
                gt(schema.invitesTable.expiresAt, now),
                or(
                  isNull(schema.invitesTable.lastSentAt),
                  lt(schema.invitesTable.lastSentAt, cooldownStart),
                ),
              ),
            )
            .returning(),
        ),
      );

      const winners = claims.filter((rows) => rows.length === 1).length;
      assert.equal(
        winners,
        1,
        `expected exactly one concurrent invite-resend claim to win, got ${winners}`,
      );
    });
  });
});

test("password reset cooldown: only one of N concurrent claims wins", async () => {
  await withTestUser(async (userId) => {
    const now = new Date();
    const cooldownStart = new Date(now.getTime() - COOLDOWN_MS);

    const claims = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        db
          .update(schema.usersTable)
          .set({ passwordResetLastSentAt: new Date() })
          .where(
            and(
              eq(schema.usersTable.id, userId),
              eq(schema.usersTable.isActive, true),
              or(
                isNull(schema.usersTable.passwordResetLastSentAt),
                lt(schema.usersTable.passwordResetLastSentAt, cooldownStart),
              ),
            ),
          )
          .returning(),
      ),
    );

    const winners = claims.filter((rows) => rows.length === 1).length;
    assert.equal(
      winners,
      1,
      `expected exactly one concurrent send-reset claim to win, got ${winners}`,
    );
  });
});

test("invite resend cooldown: a second claim within the window is rejected", async () => {
  await withTestUser(async (adminId) => {
    await withTestInvite(adminId, async (token) => {
      const now1 = new Date();
      const cooldownStart1 = new Date(now1.getTime() - COOLDOWN_MS);
      const first = await db
        .update(schema.invitesTable)
        .set({ lastSentAt: now1 })
        .where(
          and(
            eq(schema.invitesTable.token, token),
            or(
              isNull(schema.invitesTable.lastSentAt),
              lt(schema.invitesTable.lastSentAt, cooldownStart1),
            ),
          ),
        )
        .returning();
      assert.equal(first.length, 1, "first send should claim the slot");

      const now2 = new Date();
      const cooldownStart2 = new Date(now2.getTime() - COOLDOWN_MS);
      const second = await db
        .update(schema.invitesTable)
        .set({ lastSentAt: now2 })
        .where(
          and(
            eq(schema.invitesTable.token, token),
            or(
              isNull(schema.invitesTable.lastSentAt),
              lt(schema.invitesTable.lastSentAt, cooldownStart2),
            ),
          ),
        )
        .returning();
      assert.equal(
        second.length,
        0,
        "second send within the cooldown window must be rejected",
      );
    });
  });
});
