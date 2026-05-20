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
