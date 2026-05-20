/**
 * Task #293: when the model client throws a transient error (429 / 503
 * / 5xx / network), `withModelRetry` retries up to 3 times with jittered
 * exponential backoff. Non-retryable errors fail fast on the first
 * attempt. This is the guardrail that turned the demo-night Adient
 * upload's 429 RATELIMIT_EXCEEDED from a hard dispatcher-visible error
 * into a quiet ~3s pause + success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableModelError,
  runWithConcurrency,
  withModelRetry,
} from "../modelClient.js";

class FakeStatusError extends Error {
  status: number;
  constructor(status: number, msg = `HTTP ${status}`) {
    super(msg);
    this.status = status;
  }
}

const silentLog = { warn: () => {} };

test("withModelRetry: retries 429 and succeeds on 2nd attempt", async () => {
  let attempts = 0;
  const result = await withModelRetry(
    async () => {
      attempts++;
      if (attempts < 2) throw new FakeStatusError(429);
      return "ok";
    },
    { label: "test", log: silentLog },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("withModelRetry: retries 503 once, succeeds on 3rd", async () => {
  let attempts = 0;
  const result = await withModelRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new FakeStatusError(503);
      return "ok";
    },
    { label: "test", log: silentLog },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("withModelRetry: three 429s in a row rejects with the original error", async () => {
  let attempts = 0;
  await assert.rejects(
    withModelRetry(
      async () => {
        attempts++;
        throw new FakeStatusError(429, "RATELIMIT_EXCEEDED");
      },
      { label: "test", log: silentLog },
    ),
    /RATELIMIT_EXCEEDED/,
  );
  assert.equal(attempts, 3, "should attempt exactly maxAttempts times before giving up");
});

test("withModelRetry: 4xx auth error fails fast, no retry", async () => {
  let attempts = 0;
  await assert.rejects(
    withModelRetry(
      async () => {
        attempts++;
        throw new FakeStatusError(401, "invalid api key");
      },
      { label: "test", log: silentLog },
    ),
    /invalid api key/,
  );
  assert.equal(attempts, 1, "401 must not be retried");
});

test("withModelRetry: ECONNRESET / fetch failed counted as retryable", async () => {
  let attempts = 0;
  const result = await withModelRetry(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("fetch failed: socket hang up");
      if (attempts === 2) throw new Error("ECONNRESET");
      return "ok";
    },
    { label: "test", log: silentLog },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("withModelRetry: emits one WARN per retry, not on first attempt or final success", async () => {
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const captureLog = {
    warn: (obj: Record<string, unknown>, msg: string) => {
      warns.push({ obj, msg });
    },
  };
  let attempts = 0;
  await withModelRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new FakeStatusError(429);
      return "ok";
    },
    { label: "chunk-1", log: captureLog },
  );
  assert.equal(warns.length, 2, "should warn after attempts 1 and 2, not after success");
  assert.equal(warns[0].obj.attempt, 1);
  assert.equal(warns[0].obj.status, 429);
  assert.equal(warns[0].obj.label, "chunk-1");
  assert.equal(warns[1].obj.attempt, 2);
});

test("isRetryableModelError classifies cleanly", () => {
  assert.equal(isRetryableModelError(new FakeStatusError(429)), true);
  assert.equal(isRetryableModelError(new FakeStatusError(503)), true);
  assert.equal(isRetryableModelError(new FakeStatusError(500)), true);
  assert.equal(isRetryableModelError(new FakeStatusError(502)), true);
  assert.equal(isRetryableModelError(new FakeStatusError(400)), false);
  assert.equal(isRetryableModelError(new FakeStatusError(401)), false);
  assert.equal(isRetryableModelError(new FakeStatusError(404)), false);
  assert.equal(isRetryableModelError(new Error("fetch failed")), true);
  assert.equal(isRetryableModelError(new Error("ECONNRESET happened")), true);
  assert.equal(isRetryableModelError(new Error("schema mismatch")), false);
  assert.equal(isRetryableModelError(null), false);
  assert.equal(isRetryableModelError("nope"), false);
});

test("runWithConcurrency: caps in-flight calls and preserves index order", async () => {
  const count = 8;
  const concurrency = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await runWithConcurrency(count, concurrency, async (idx) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return idx * 2;
  });
  assert.equal(results.length, count);
  for (let i = 0; i < count; i++) assert.equal(results[i], i * 2);
  assert.ok(
    maxInFlight <= concurrency,
    `expected <=${concurrency} in flight, observed ${maxInFlight}`,
  );
  assert.ok(maxInFlight >= 2, `expected real parallelism, observed only ${maxInFlight}`);
});

test("runWithConcurrency: isAborted flag stops dequeuing", async () => {
  let attempted = 0;
  let aborted = false;
  await runWithConcurrency(
    20,
    3,
    async (idx) => {
      attempted++;
      if (idx === 2) aborted = true;
      return idx;
    },
    { isAborted: () => aborted },
  );
  assert.ok(
    attempted < 20,
    `abort flag must stop the pool early, attempted ${attempted} of 20`,
  );
});
