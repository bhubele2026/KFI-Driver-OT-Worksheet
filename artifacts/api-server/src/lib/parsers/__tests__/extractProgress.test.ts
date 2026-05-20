/**
 * Task #296 — in-process progress tracker basics. The chunked AI
 * extractor publishes "chunk N of M" snapshots here; the frontend
 * polls via GET /weeks/:weekStart/extract-progress/:key.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  publishExtractProgress,
  readExtractProgress,
  clearExtractProgress,
  publishExtractResult,
  readExtractResult,
  __resetExtractProgressForTests,
} from "../extractProgress.js";

beforeEach(() => {
  __resetExtractProgressForTests();
});

test("publish + read returns the latest snapshot", () => {
  publishExtractProgress("k1", 1, 10);
  assert.deepEqual(readExtractProgress("k1"), { current: 1, total: 10 });
  publishExtractProgress("k1", 7, 10);
  assert.deepEqual(readExtractProgress("k1"), { current: 7, total: 10 });
});

test("read returns null when the key was never published", () => {
  assert.equal(readExtractProgress("never"), null);
});

test("publish is a no-op when key is undefined or empty", () => {
  publishExtractProgress(undefined, 1, 1);
  assert.equal(readExtractProgress(""), null);
});

test("clear removes a published key", () => {
  publishExtractProgress("k2", 2, 5);
  clearExtractProgress("k2");
  assert.equal(readExtractProgress("k2"), null);
});

// Task #328: the chunked extractor threads its `resumedFromStaging`
// count through every tick so the polling client can render
// "Resumed N of M — re-running K" on retried uploads.
test("publish carries resumedFromStaging through to the snapshot", () => {
  publishExtractProgress("k3", 0, 70, 42);
  assert.deepEqual(readExtractProgress("k3"), {
    current: 0,
    total: 70,
    resumedFromStaging: 42,
  });
  publishExtractProgress("k3", 5, 70, 42);
  assert.deepEqual(readExtractProgress("k3"), {
    current: 5,
    total: 70,
    resumedFromStaging: 42,
  });
});

test("omitting resumedFromStaging leaves it off the snapshot", () => {
  publishExtractProgress("k4", 3, 10);
  assert.deepEqual(readExtractProgress("k4"), { current: 3, total: 10 });
});

// Task #369 — terminal-result store. The extract route monkey-patches
// `res.json` to stash its terminal body here so the client can recover
// after the Replit proxy's 5-minute cap kills the original POST.
test("publishExtractResult + readExtractResult round-trips success payloads", () => {
  publishExtractResult("r1", 200, { sampleId: "s-1", customer: "Penda" });
  const got = readExtractResult("r1");
  assert.equal(got?.httpStatus, 200);
  assert.deepEqual(got?.body, { sampleId: "s-1", customer: "Penda" });
});

test("publishExtractResult captures non-2xx status alongside the error body", () => {
  publishExtractResult("r2", 400, { error: "AI extraction timed out" });
  const got = readExtractResult("r2");
  assert.equal(got?.httpStatus, 400);
  assert.deepEqual(got?.body, { error: "AI extraction timed out" });
});

test("publishExtractResult is a no-op when key is undefined or empty", () => {
  publishExtractResult(undefined, 200, { ok: true });
  publishExtractResult("", 200, { ok: true });
  assert.equal(readExtractResult(""), null);
});

test("readExtractResult returns null for an unknown key", () => {
  assert.equal(readExtractResult("never-published"), null);
});

// Task #369 — clearing progress MUST NOT clear the stashed result.
// The client may not pick the result up until well after the
// extractor has finished and the route's `finally` cleared progress;
// dropping the result on the floor here would re-introduce the
// "Upload failed" symptom this task fixes.
test("clearExtractProgress leaves the stashed result intact", () => {
  publishExtractProgress("r3", 5, 5);
  publishExtractResult("r3", 200, { sampleId: "s-3" });
  clearExtractProgress("r3");
  assert.equal(readExtractProgress("r3"), null);
  assert.deepEqual(readExtractResult("r3")?.body, { sampleId: "s-3" });
});

// Replacing a stashed result mirrors the progress publisher: the
// latest call wins. Belt-and-suspenders — the route only stashes
// once per request, but the contract here should still hold.
test("publishExtractResult is last-write-wins for the same key", () => {
  publishExtractResult("r4", 200, { first: true });
  publishExtractResult("r4", 500, { error: "boom" });
  const got = readExtractResult("r4");
  assert.equal(got?.httpStatus, 500);
  assert.deepEqual(got?.body, { error: "boom" });
});
