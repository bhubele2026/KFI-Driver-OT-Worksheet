/**
 * Task #296 — verify the three rate-shaping pieces that let the
 * tier-1 Anthropic key finish the 71-chunk Adient first-time upload:
 *
 *   1. Claude content blocks carry `cache_control: { type: "ephemeral" }`
 *      when their source `ContentPart` is flagged `cacheable: true`.
 *   2. `parseRetryAfterMs` honours both `retry-after` and
 *      `anthropic-ratelimit-input-tokens-reset`, capped at 70s.
 *   3. The `LeakyBucketPacer` blocks an `acquire()` that would push
 *      total in-window tokens past capacity, and unblocks once enough
 *      virtual time has passed for the oldest event to fall out of
 *      the trailing window.
 *   4. `withModelRetry` honours the retry-after hint over its generic
 *      exponential backoff on 429.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRetryAfterMs,
  __makeTestLeakyBucketPacer,
  withModelRetry,
} from "../modelClient.js";
import { _toClaudeContentForTests } from "../claude.js";

test("Claude content: cacheable text block carries cache_control ephemeral", () => {
  const blocks = _toClaudeContentForTests([
    { kind: "text", text: "RULES + ROSTER prefix", cacheable: true },
    { kind: "text", text: "chunk body" },
  ]);
  assert.equal(blocks.length, 2);
  const first = blocks[0] as { type: string; cache_control?: { type: string } };
  assert.equal(first.type, "text");
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
  const second = blocks[1] as { type: string; cache_control?: unknown };
  assert.equal(second.type, "text");
  assert.equal(second.cache_control, undefined);
});

test("parseRetryAfterMs reads retry-after seconds from fetch-spec Headers, capped at 70s", () => {
  const h = new Headers({ "retry-after": "42" });
  const err = { status: 429, headers: h };
  assert.equal(parseRetryAfterMs(err), 42_000);
  const huge = new Headers({ "retry-after": "9999" });
  assert.equal(parseRetryAfterMs({ headers: huge }), 70_000);
});

test("parseRetryAfterMs reads anthropic-ratelimit-input-tokens-reset (ISO timestamp)", () => {
  const future = new Date(Date.now() + 12_000).toISOString();
  const err = {
    status: 429,
    headers: new Headers({
      "anthropic-ratelimit-input-tokens-reset": future,
    }),
  };
  const ms = parseRetryAfterMs(err);
  assert.ok(ms !== undefined && ms > 9_000 && ms <= 12_500, `got ${ms}`);
});

test("parseRetryAfterMs returns undefined when no usable hint is present", () => {
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs({ status: 500 }), undefined);
  assert.equal(
    parseRetryAfterMs({ headers: new Headers({ "x-other": "1" }) }),
    undefined,
  );
});

test("LeakyBucketPacer blocks acquire that would exceed capacity, then unblocks after window rolls", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const pacer = __makeTestLeakyBucketPacer(
    25_000,
    60_000,
    () => now,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  );
  // Two 10k acquires fit (20k in-window); the third 10k would push to
  // 30k > 25k cap, so it must sleep until the oldest event ages out.
  await pacer.acquire(10_000);
  await pacer.acquire(10_000);
  const t0 = now;
  await pacer.acquire(10_000);
  // Slept until t = windowMs (60_000) — the first event at t=0 falls
  // out, freeing 10k of capacity.
  assert.ok(sleeps.length >= 1, "should have slept at least once");
  assert.ok(now - t0 >= 50_000, `expected to skip ~window, advanced ${now - t0}ms`);
});

test("withModelRetry honours retry-after hint over generic exponential backoff on 429", async () => {
  let attempts = 0;
  const realSetTimeout = setTimeout;
  const sleeps: number[] = [];
  // Patch setTimeout so the test runs instantly while still recording
  // the requested delay.
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms: number,
  ) => {
    sleeps.push(ms);
    return realSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout;
  try {
    const res = await withModelRetry(
      async () => {
        attempts++;
        if (attempts < 2) {
          const err = Object.assign(new Error("429"), {
            status: 429,
            headers: new Headers({ "retry-after": "3" }),
          });
          throw err;
        }
        return "ok";
      },
      { label: "test", maxAttempts: 3 },
    );
    assert.equal(res, "ok");
    assert.equal(attempts, 2);
    // The honoured retry-after is 3s = 3000ms, NOT the generic
    // 1500ms+jitter exponential.
    assert.ok(
      sleeps.includes(3000),
      `expected a 3000ms sleep, got ${sleeps.join(",")}`,
    );
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
});
