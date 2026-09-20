import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * The two promises made to Brad about a sleeping Mac, pinned as tests.
 *
 *   1. Pressing the button while the Mac is asleep DEFERS the sweep; it never
 *      loses it, and it never stacks duplicates.
 *   2. Several missed nights collapse into ONE sweep covering the whole gap,
 *      because the window is computed when the Mac claims the run — not when
 *      the run was queued.
 *
 * Needs a database. Skips loudly rather than silently passing when there is
 * none: a test that quietly does nothing is worse than no test.
 */
const HAVE_DB = Boolean(process.env.DATABASE_URL);
const why = "needs DATABASE_URL (use a scratch DB — never prod)";

describe("sweep queue — a sleeping Mac defers work, never loses it", { skip: HAVE_DB ? false : why }, () => {
  it("does not stack a second sweep while one is waiting", async () => {
    const { queueSweep, pendingSweeps } = await import("../macQueue.js");
    const { db, schema } = await import("../../db.js");
    await db.delete(schema.payrollSweepRunsTable);

    const first = await queueSweep("manual", "tyedro@kfi.group");
    assert.equal(first.alreadyQueued, false);
    assert.equal(first.status, "queued");

    // She presses again. The nightly tick also fires. Still one sweep.
    const second = await queueSweep("manual", "tyedro@kfi.group");
    const third = await queueSweep("nightly", null);
    assert.equal(second.runId, first.runId);
    assert.equal(third.runId, first.runId);
    assert.equal(second.alreadyQueued, true);
    assert.equal(await pendingSweeps(), 1);
  });

  it("collapses a multi-day gap into one sweep covering the whole gap", async () => {
    const { queueSweep, claimSweep } = await import("../macQueue.js");
    const { db, schema } = await import("../../db.js");
    await db.delete(schema.payrollSweepRunsTable);

    // A sweep that succeeded four days ago, then the Mac slept.
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000);
    await db.insert(schema.payrollSweepRunsTable).values({
      trigger: "nightly", triggeredBy: null,
      windowFrom: new Date(fourDaysAgo.getTime() - 86_400_000),
      windowTo: fourDaysAgo,
      status: "ok", claimedAt: fourDaysAgo, finishedAt: fourDaysAgo, counts: {},
    });

    await queueSweep("nightly", null);
    const claim = await claimSweep();
    assert.ok(claim, "a queued sweep should be claimable");

    // The window reaches back to the last SUCCESS (minus the overlap), not to
    // whenever this run happened to be queued — so nothing in the gap is missed.
    const from = new Date(claim!.windowFrom).getTime();
    const expected = fourDaysAgo.getTime() - 2 * 86_400_000;
    assert.ok(Math.abs(from - expected) < 60_000,
      `window should start ~6 days back, got ${claim!.windowFrom}`);
    assert.ok(new Date(claim!.windowTo).getTime() > Date.now() - 60_000,
      "window should end now, not when it was queued");
  });

  it("re-queues a run whose executor died without reporting", async () => {
    const { queueSweep } = await import("../macQueue.js");
    const { db, schema } = await import("../../db.js");
    await db.delete(schema.payrollSweepRunsTable);

    // Claimed an hour ago and never finished — the Mac was closed mid-run.
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    const [dead] = await db.insert(schema.payrollSweepRunsTable).values({
      trigger: "manual", triggeredBy: "tyedro@kfi.group",
      windowFrom: anHourAgo, windowTo: anHourAgo,
      status: "running", claimedAt: anHourAgo, counts: {},
    }).returning({ id: schema.payrollSweepRunsTable.id });

    const q = await queueSweep("manual", "tyedro@kfi.group");
    assert.equal(q.runId, dead!.id, "should revive the stuck run, not orphan it");
    assert.equal(q.status, "queued");
  });

  it("only queues a fresh sweep once the last one has finished", async () => {
    const { queueSweep, claimSweep, finishSweep } = await import("../macQueue.js");
    const { db, schema } = await import("../../db.js");
    await db.delete(schema.payrollSweepRunsTable);

    const first = await queueSweep("manual", null);
    await claimSweep();
    await finishSweep(first.runId, { ok: true, counts: { posted: 3 } });

    const next = await queueSweep("nightly", null);
    assert.notEqual(next.runId, first.runId);
    assert.equal(next.alreadyQueued, false);
  });
});
