/**
 * Task #352 — confirm-customer-file re-extract fallback.
 *
 * When a stashed `ai_extract_samples` row has empty `extractedRows` AND
 * empty `pendingNamedRows` but `fileBytes` is still present, the confirm
 * route re-runs `extractImageForKnownCustomer` against the stashed bytes
 * and commits the resulting rows the same way it commits a freshly
 * extracted sample. The route handler isn't directly instantiable from
 * a unit test (it needs the full express + session stack), so this
 * test pins the seam the fallback depends on: invoking
 * `extractImageForKnownCustomer` with arbitrary buffer bytes + a stubbed
 * AI response produces both fully-resolved `punches` and `pendingNamedRows`
 * the route can then merge into the in-memory sample.
 *
 * If this test breaks — e.g. the helper changes shape so the confirm
 * fallback can no longer reuse it — the dispatcher's stuck-confirm bug
 * returns. Keep both halves (resolved rows + pending) asserted; the
 * confirm path drops back into `explainZeroPunches` only when BOTH are
 * empty after the re-extract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImageForKnownCustomer } from "../imageSupport.js";
import {
  __pushAiExtractStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";

// Arbitrary stashed bytes — what `sample.fileBytes` looks like when the
// confirm fallback hands them to the AI extractor. We never inspect the
// bytes here; the stub short-circuits the real provider call.
const STASHED_BYTES = Buffer.from(
  "%PDF-1.4 stashed-sample-fixture\n%%EOF\n",
  "utf8",
);

const drivers = [
  { kfiId: "K100", name: "Anna Driver", customer: "Penda" },
  { kfiId: "K101", name: "Brad Driver", customer: "Penda" },
];
const kfiSet = new Set(drivers.map((d) => d.kfiId));

test("confirm re-extract path produces resolved punches from stashed bytes", async () => {
  __clearAiExtractStubs();
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Anna Driver",
      date: "2026-05-12",
      timeIn: "07:00",
      timeOut: "15:00",
      resolvedKfiId: "K100",
    },
  ] as never);
  const result = await extractImageForKnownCustomer({
    fileName: "Penda Daily punches.xlsx",
    buffer: STASHED_BYTES,
    mimeType: "application/octet-stream",
    customer: "Penda",
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
    idMap: {},
    drivers,
    kfiSet,
  });
  assert.equal(result.punches.length, 1);
  assert.equal(result.punches[0].kfiId, "K100");
  assert.equal(result.punches[0].customer, "Penda");
  // Non-empty rows let the confirm path skip `explainZeroPunches` and
  // fall through to the existing commit transaction.
  const isCommittable =
    result.punches.length > 0 || (result.pendingNamedRows?.length ?? 0) > 0;
  assert.equal(isCommittable, true);
});

test("confirm re-extract path stashes name-only rows as pendingNamedRows", async () => {
  // The dispatcher hadn't picked an alias yet, so the AI couldn't tie
  // this row to a kfiId. The confirm path still treats the sample as
  // committable (the picker tx body re-resolves pendingNamedRows
  // against just-written aliases).
  __clearAiExtractStubs();
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Unmapped Name",
      date: "2026-05-12",
      timeIn: "07:00",
      timeOut: "15:00",
    },
  ] as never);
  const result = await extractImageForKnownCustomer({
    fileName: "Penda Daily punches.xlsx",
    buffer: STASHED_BYTES,
    mimeType: "application/octet-stream",
    customer: "Penda",
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
    idMap: {},
    drivers,
    kfiSet,
  });
  assert.equal(result.punches.length, 0);
  assert.equal(result.pendingNamedRows?.length ?? 0, 1);
  const isCommittable =
    result.punches.length > 0 || (result.pendingNamedRows?.length ?? 0) > 0;
  assert.equal(isCommittable, true);
});

test("confirm re-extract path returns zero/zero when the AI sees no usable rows — confirm route then surfaces explainZeroPunches", async () => {
  __clearAiExtractStubs();
  __pushAiExtractStub([] as never);
  const result = await extractImageForKnownCustomer({
    fileName: "Penda Daily punches.xlsx",
    buffer: STASHED_BYTES,
    mimeType: "application/octet-stream",
    customer: "Penda",
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
    idMap: {},
    drivers,
    kfiSet,
  });
  assert.equal(result.punches.length, 0);
  assert.equal(result.pendingNamedRows?.length ?? 0, 0);
  // This is the only case where the confirm fallback bails to a 400 —
  // and crucially the new error is the diagnostics-rich
  // `explainZeroPunches` string, not the misleading
  // "older parser path has been removed" copy this task retired.
});
