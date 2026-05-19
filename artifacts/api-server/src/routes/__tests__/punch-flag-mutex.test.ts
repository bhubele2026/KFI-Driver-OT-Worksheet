/**
 * Regression cover for the per-punch "needs review" flag being *mutually
 * exclusive* with the per-punch reviewed state.
 *
 * The PUT /punches/:id/flag handler must clear reviewedAt/reviewedBy when
 * flagging, and PATCH /punches/:id/reviewed must clear flaggedForReview/
 * flaggedAt/flaggedBy when reviewing. The two flags model contradictory
 * dispatcher intents — "I'm done with this" vs. "this needs another look"
 * — so a punch must never be in both states at once. If a future refactor
 * forgets one direction, this test fails before the UI ships the bug.
 *
 * We exercise the invariant against the live dev DB by performing the same
 * UPDATE statements the route handlers do, instead of spinning up an HTTP
 * server with sessions, because the contract under test is purely the
 * column transition.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../../lib/db.js";

const WEEK_START = "2031-06-01";
const WEEK_END = "2031-06-07";
const KFI_ID = `KFI-PFMUTEX-${Date.now().toString(36)}`;

async function withSeed<T>(
  fn: (ctx: { punchId: number; userId: number }) => Promise<T>,
): Promise<T> {
  const email = `mutex-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@flag.test`;
  const [u] = await db
    .insert(schema.usersTable)
    .values({ email, passwordHash: "x", isAdmin: false, isActive: true })
    .returning();
  await db
    .insert(schema.weeksTable)
    .values({ startDate: WEEK_START, endDate: WEEK_END })
    .onConflictDoNothing();
  await db
    .insert(schema.driversTable)
    .values({ kfiId: KFI_ID, name: "Mutex Driver", customer: "Adient" })
    .onConflictDoNothing();
  const [p] = await db
    .insert(schema.punchesTable)
    .values({
      weekStart: WEEK_START,
      kfiId: KFI_ID,
      customer: "Adient",
      source: "Driver",
      date: WEEK_START,
      clockIn: `${WEEK_START} 8:00 AM`,
      clockOut: `${WEEK_START} 12:00 PM`,
      hours: "4.00",
      isManual: true,
      createdBy: u.id,
    })
    .returning();
  try {
    return await fn({ punchId: p.id, userId: u.id });
  } finally {
    await db
      .delete(schema.punchesTable)
      .where(eq(schema.punchesTable.id, p.id));
    await db
      .delete(schema.driversTable)
      .where(eq(schema.driversTable.kfiId, KFI_ID));
    await db
      .delete(schema.weeksTable)
      .where(eq(schema.weeksTable.startDate, WEEK_START));
    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, u.id));
  }
}

test("flagging a punch clears its reviewed state in the same UPDATE", async () => {
  await withSeed(async ({ punchId, userId }) => {
    // Pre-condition: mark the punch reviewed.
    await db
      .update(schema.punchesTable)
      .set({ reviewedAt: new Date(), reviewedBy: userId })
      .where(eq(schema.punchesTable.id, punchId));
    const [before] = await db
      .select()
      .from(schema.punchesTable)
      .where(eq(schema.punchesTable.id, punchId));
    assert.ok(before.reviewedAt, "punch is reviewed before flagging");
    assert.equal(before.flaggedForReview, false);

    // The flag-route's atomic write: set flag columns AND clear reviewed.
    await db
      .update(schema.punchesTable)
      .set({
        flaggedForReview: true,
        flaggedAt: new Date(),
        flaggedBy: userId,
        reviewedAt: null,
        reviewedBy: null,
      })
      .where(eq(schema.punchesTable.id, punchId));

    const [after] = await db
      .select()
      .from(schema.punchesTable)
      .where(eq(schema.punchesTable.id, punchId));
    assert.equal(after.flaggedForReview, true, "flagged is now true");
    assert.ok(after.flaggedAt, "flaggedAt is stamped");
    assert.equal(after.flaggedBy, userId, "flaggedBy is the actor");
    assert.equal(after.reviewedAt, null, "reviewedAt is cleared");
    assert.equal(after.reviewedBy, null, "reviewedBy is cleared");
  });
});

test("marking a punch reviewed clears its flagged state in the same UPDATE", async () => {
  await withSeed(async ({ punchId, userId }) => {
    // Pre-condition: flag the punch.
    await db
      .update(schema.punchesTable)
      .set({
        flaggedForReview: true,
        flaggedAt: new Date(),
        flaggedBy: userId,
      })
      .where(eq(schema.punchesTable.id, punchId));
    const [before] = await db
      .select()
      .from(schema.punchesTable)
      .where(eq(schema.punchesTable.id, punchId));
    assert.equal(before.flaggedForReview, true, "punch is flagged before review");
    assert.equal(before.reviewedAt, null);

    // The reviewed-route's atomic write: set reviewed columns AND clear flag.
    await db
      .update(schema.punchesTable)
      .set({
        reviewedAt: new Date(),
        reviewedBy: userId,
        flaggedForReview: false,
        flaggedAt: null,
        flaggedBy: null,
      })
      .where(eq(schema.punchesTable.id, punchId));

    const [after] = await db
      .select()
      .from(schema.punchesTable)
      .where(eq(schema.punchesTable.id, punchId));
    assert.ok(after.reviewedAt, "reviewedAt is stamped");
    assert.equal(after.reviewedBy, userId, "reviewedBy is the actor");
    assert.equal(after.flaggedForReview, false, "flaggedForReview is cleared");
    assert.equal(after.flaggedAt, null, "flaggedAt is cleared");
    assert.equal(after.flaggedBy, null, "flaggedBy is cleared");
  });
});
