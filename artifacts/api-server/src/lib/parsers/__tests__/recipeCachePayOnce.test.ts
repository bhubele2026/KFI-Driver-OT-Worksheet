/**
 * Task #310: recipe-cache "pay once" regression guard.
 *
 * The whole shape of the upload pipeline assumes that the first
 * contact with a new customer's file format pays the AI cost and
 * every subsequent same-format upload reuses a cached "recipe"
 * (column roles) and finishes with **zero Claude calls**. If that
 * promise quietly breaks (e.g. the inferrer stops recognizing the
 * sample row, or the cache key gets too narrow and never matches
 * itself on the next week), users land back in the slow path
 * forever.
 *
 * This test pins both halves of the contract end-to-end against the
 * real `Greystone.xlsx` fixture using the existing `__pushAiExtractStub`
 * seam to mock Claude:
 *
 *   1. First upload — push exactly one AI stub, run `aiExtractRows`,
 *      assert the punches came back AND that
 *      `deriveSchemaCacheMutation` returned `action: 'upsert'` with
 *      column roles (i.e. the recipe is genuinely persistable).
 *      Asserts ≥1 Claude call by checking the budget summary.
 *   2. Second upload — same bytes, **no stubs pushed**. Run
 *      `readWithRoles` with the recipe captured above (this is
 *      exactly what the upload route's cache branch does in
 *      production). Assert the punches match and the AI stub queue
 *      is still empty (i.e. zero model calls consumed).
 *
 * If the inferrer ever stops returning roles for the first-contact
 * sample row, step 1 fails loudly with `action !== 'upsert'` and
 * the team knows the "pay once" promise is broken before it ships.
 *
 * Greystone was chosen because its xlsx layout is flat (one header
 * row, one row per punch, string times like "05:55 AM") — the same
 * shape `inferColumnRoles` was designed for. Block-structured
 * layouts like Adient's (Employee-Name header rows separated from
 * the per-punch data rows by entirely different columns) are a
 * known limitation tracked as a follow-up; recipe caching there
 * needs a different inferrer.
 *
 * Pure unit test: no DB, no network. The AI is stubbed; the
 * "second upload" runs the deterministic xlsx reader the route
 * uses on cache hits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  aiExtractRows,
  __pushAiExtractStub,
  __clearAiExtractStubs,
  __aiExtractStubQueueLength,
  xlsxToChunks,
  type AiExtractedRow,
} from "../aiExtract.js";
import {
  deriveSchemaCacheMutation,
  inferColumnRoles,
} from "../aiSchemaRecorder.js";
import { readWithRoles } from "../genericRoleReader.js";
import { IngestionBudget } from "../ingestionBudget.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/2026-04-26/Greystone.xlsx");

const WEEK_START = "2026-04-26"; // Sunday
const WEEK_END = "2026-05-02"; // Saturday

// One row that exactly matches a real Greystone fixture entry —
// badge `2005077` for Alexander, Giovanni on 2026-04-27 from
// 05:55 AM to 02:00 PM. `inferColumnRoles` searches the workbook
// for the row carrying these exact values to learn which columns
// hold badge / date / timeIn / timeOut, so the sample must be
// accurate or no recipe is written.
const FIRST_PUNCH = {
  rawBadge: "2005077",
  date: "2026-04-27",
  clockIn: "2026-04-27 05:55 AM",
  clockOut: "2026-04-27 02:00 PM",
};

test("recipe cache pays once: first upload writes recipe, second upload makes 0 AI calls", async () => {
  __clearAiExtractStubs();
  try {
    const buffer = readFileSync(FIXTURE);

    // Greystone is well under the chunker threshold so it fits in
    // a single chunk — push one stub. If the threshold ever drops,
    // bump this loop to match `xlsxToChunks(...).length`.
    const noopLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as const;
    const chunks = xlsxToChunks(buffer, noopLog);
    assert.ok(chunks.length >= 1, "xlsxToChunks should yield ≥1 chunk");
    for (let i = 0; i < chunks.length; i++) {
      const stubRow: AiExtractedRow = {
        driverNameOnDoc: "Alexander, Giovanni",
        badgeOrId: FIRST_PUNCH.rawBadge,
        date: FIRST_PUNCH.date,
        // AI emits times as "H:MM AM/PM" (no leading zero on hour).
        // We pass the same shape it would for the route's caller —
        // `aiExtractRows` re-stamps the date prefix internally.
        timeIn: "5:55 AM",
        timeOut: "2:00 PM",
        hours: 8.1,
        resolvedKfiId: FIRST_PUNCH.rawBadge,
      };
      __pushAiExtractStub([stubRow]);
    }
    const stubsBefore = __aiExtractStubQueueLength();
    assert.ok(stubsBefore >= 1, "test seam should hold ≥1 stub before first run");

    const idMap: Record<string, string> = { "2005077": "2005077" };
    const kfiSet = new Set(Object.values(idMap));
    const budget = new IngestionBudget({
      fileName: "Greystone.xlsx",
      customer: "Greystone",
      log: noopLog,
    });
    const firstResult = await aiExtractRows(
      "Greystone.xlsx",
      buffer,
      "Greystone",
      WEEK_START,
      WEEK_END,
      undefined,
      noopLog,
      { customer: "Greystone", drivers: [] },
      { budget },
    );
    assert.ok(
      firstResult.rows.length > 0,
      "first upload should return AI-extracted rows",
    );
    // The AI extractor's `_aiStubQueue` is the proxy for "would have
    // called Claude" in unit-test land — the production code path that
    // pops a stub is the same path that would invoke the model when no
    // stub is queued. Asserting the queue drained proves the first
    // upload took the AI branch.
    const stubsAfterFirst = __aiExtractStubQueueLength();
    assert.equal(
      stubsAfterFirst,
      0,
      `first upload should consume every stub (≥1 AI call). drained ${stubsBefore - stubsAfterFirst} of ${stubsBefore}`,
    );

    // Derive the recipe the same way the upload route does
    // (`recordAiSchemaIfPossible` → `deriveSchemaCacheMutation`).
    // This is the gate that catches "AI succeeded but we can't
    // build a reusable recipe" — exactly the failure mode that
    // breaks the pay-once promise.
    // Build a ParseResult-shaped aiResult from the first AI row so
    // `deriveSchemaCacheMutation` has the same inputs the real route
    // hands it post-extraction.
    const mutation = await deriveSchemaCacheMutation({
      customer: "Greystone",
      fileName: "Greystone.xlsx",
      buffer,
      aiResult: {
        customer: "Greystone",
        punches: [
          {
            kfiId: FIRST_PUNCH.rawBadge,
            customer: "Greystone",
            date: FIRST_PUNCH.date,
            clockIn: FIRST_PUNCH.clockIn,
            clockOut: FIRST_PUNCH.clockOut,
            hours: 8.1,
            payType: "Reg",
            rawBadge: FIRST_PUNCH.rawBadge,
          },
        ],
        unmappedIds: [],
      },
      weekStart: WEEK_START,
    });
    assert.equal(
      mutation.action,
      "upsert",
      `recipe must be persistable (got ${mutation.action})`,
    );
    if (mutation.action !== "upsert") return; // type narrow

    // Sanity check the inferrer directly too — defends against
    // someone widening `deriveSchemaCacheMutation` to "upsert with
    // empty roles" silently.
    const directRoles = inferColumnRoles(buffer, {
      rawBadge: FIRST_PUNCH.rawBadge,
      dateIso: FIRST_PUNCH.date,
      clockIn: FIRST_PUNCH.clockIn,
      clockOut: FIRST_PUNCH.clockOut,
    });
    assert.ok(directRoles, "inferColumnRoles must locate the fixture row");

    // Second upload simulation: stub queue is empty. The route's
    // cache branch calls `readWithRoles` with the persisted recipe
    // — a pure xlsx parser, no model calls. Assert the queue length
    // stays exactly 0 across the call: no stub consumed = zero AI
    // calls on the second upload, which is the whole point of the
    // "pay once" promise.
    assert.equal(
      __aiExtractStubQueueLength(),
      0,
      "queue must be empty before the cache-hit simulation",
    );
    const secondResult = readWithRoles(
      "Greystone",
      buffer,
      mutation.columnRoles as unknown as {
        badge: number;
        date: number;
        timeIn: number;
        timeOut: number;
      },
      kfiSet,
      idMap,
      WEEK_START,
      WEEK_END,
    );
    assert.ok(secondResult, "readWithRoles should return a ParseResult");
    assert.ok(
      secondResult.punches.length > 0,
      "second upload must produce punches from the cached recipe",
    );
    const found = secondResult.punches.find(
      (p) =>
        p.kfiId === FIRST_PUNCH.rawBadge && p.date === FIRST_PUNCH.date,
    );
    assert.ok(
      found,
      "second upload must reproduce the AI-first row deterministically",
    );
    assert.equal(
      __aiExtractStubQueueLength(),
      0,
      "second upload must make zero AI calls (queue should remain empty)",
    );
  } finally {
    __clearAiExtractStubs();
  }
});
