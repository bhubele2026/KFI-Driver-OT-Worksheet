import test from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";

import { db, schema } from "../db.js";
import {
  listRecentlyHiddenNotes,
  runHiddenNotesDigest,
} from "../hiddenNotesDigest.js";

// Guards the digest query's window + actor-resolution. Seeds three notes:
//   - hidden 1h ago by an actor       → MUST appear
//   - hidden 36h ago (outside window) → MUST NOT appear
//   - never hidden                    → MUST NOT appear
// Plus asserts that runHiddenNotesDigest short-circuits silently when SMTP
// is not configured (the test env has no SMTP_* vars), mirroring the
// "silent no-op" semantics of every other mail-sending code path.

test("listRecentlyHiddenNotes returns only notes hidden within the window", async () => {
  const tag = `digest-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const kfiId = `KFI-${tag}`;
  const weekStart = "2026-04-26";

  const [actor] = await db
    .insert(schema.usersTable)
    .values({
      email: `${tag}-actor@example.test`,
      passwordHash: "x",
      isAdmin: false,
      isActive: true,
    })
    .returning({ id: schema.usersTable.id });

  await db.insert(schema.driversTable).values({
    kfiId,
    name: `Test Driver ${tag}`,
    customer: "Test",
  });

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const thirtySixHoursAgo = new Date(now.getTime() - 36 * 60 * 60 * 1000);

  const inserted = await db
    .insert(schema.driverNotesTable)
    .values([
      {
        weekStart,
        kfiId,
        body: `recent-${tag}`,
        authorRole: "reviewer",
        deletedAt: oneHourAgo,
        deletedByUserId: actor.id,
      },
      {
        weekStart,
        kfiId,
        body: `old-${tag}`,
        authorRole: "reviewer",
        deletedAt: thirtySixHoursAgo,
        deletedByUserId: actor.id,
      },
      {
        weekStart,
        kfiId,
        body: `live-${tag}`,
        authorRole: "reviewer",
      },
    ])
    .returning({ id: schema.driverNotesTable.id });

  const ids = inserted.map((r) => r.id);

  try {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const rows = await listRecentlyHiddenNotes(since);
    const mine = rows.filter((r) => r.kfiId === kfiId);
    assert.equal(mine.length, 1, "only the recent hidden note should match");
    const only = mine[0];
    assert.equal(only.body, `recent-${tag}`);
    assert.equal(only.driverName, `Test Driver ${tag}`);
    assert.equal(only.deletedByEmail, `${tag}-actor@example.test`);
    assert.equal(only.weekStart, weekStart);

    // SMTP isn't configured in tests, so the digest must no-op without
    // throwing and report mailer-not-configured.
    const result = await runHiddenNotesDigest(now);
    assert.equal(result.skippedReason, "mailer-not-configured");
    assert.equal(result.delivered, 0);
  } finally {
    if (ids.length > 0) {
      await db
        .delete(schema.driverNotesTable)
        .where(inArray(schema.driverNotesTable.id, ids));
    }
    await db
      .delete(schema.driversTable)
      .where(inArray(schema.driversTable.kfiId, [kfiId]));
    await db
      .delete(schema.usersTable)
      .where(inArray(schema.usersTable.id, [actor.id]));
  }
});
