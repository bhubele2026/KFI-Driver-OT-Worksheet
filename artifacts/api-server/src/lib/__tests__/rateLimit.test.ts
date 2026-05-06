import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  __testing,
  checkLoginLimits,
  loginEmailLimiter,
  loginIpLimiter,
  recordLoginFailure,
  recordLoginSuccess,
  setRateLimitEventSink,
} from "../rateLimit.js";

// Force a fresh in-memory backend for the test suite so buckets don't bleed
// between tests and so we don't depend on a real Postgres connection here.
__testing.setRateLimitBackend(__testing.createMemoryBackend());

function fakeReq(ip: string): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    log: { warn() {}, info() {}, error() {} },
  } as unknown as Request;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

async function resetIp(ip: string) {
  await loginIpLimiter.reset(`ip:${ip}`);
}
async function resetEmail(email: string) {
  await loginEmailLimiter.reset(`email:${email}`);
}

test("per-email limiter blocks after 5 failures and 429s on the 6th", async () => {
  const ip = "10.0.0.1";
  const email = "alice@example.com";
  await resetIp(ip);
  await resetEmail(email);

  for (let i = 0; i < 5; i++) {
    const res = fakeRes();
    assert.equal(await checkLoginLimits(fakeReq(ip), res, email), true);
    await recordLoginFailure(fakeReq(ip), email);
  }
  const res = fakeRes();
  const ok = await checkLoginLimits(fakeReq(ip), res, email);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers["Retry-After"]);
});

test("successful login does NOT clear prior IP failures", async () => {
  const ip = "10.0.0.2";
  const attacker = "victim@example.com";
  const valid = "attacker-owned@example.com";
  await resetIp(ip);
  await resetEmail(attacker);
  await resetEmail(valid);

  // Burn most of the per-IP budget (20/15min) attacking the victim email,
  // staying under the per-email cap (5) by spreading across multiple emails.
  for (let i = 0; i < 19; i++) {
    await recordLoginFailure(fakeReq(ip), `decoy${i}@example.com`);
  }

  // Attacker successfully logs into a valid account they own.
  await recordLoginSuccess(fakeReq(ip), valid);

  // Per-email reset for the successful email is fine, but the IP bucket
  // must still reflect prior failures. The 20th IP failure should be the
  // last allowed attempt; the 21st must be 429.
  const r1 = fakeRes();
  assert.equal(await checkLoginLimits(fakeReq(ip), r1, attacker), true);
  await recordLoginFailure(fakeReq(ip), attacker);

  const r2 = fakeRes();
  const ok = await checkLoginLimits(fakeReq(ip), r2, attacker);
  assert.equal(ok, false, "IP bucket should still be exhausted after success");
  assert.equal(r2.statusCode, 429);
});

test("event sink fires once when a bucket first crosses its threshold", async () => {
  const ip = "10.0.0.99";
  const email = "sinkcheck@example.com";
  await resetIp(ip);
  await resetEmail(email);

  const events: { name: string; key: string }[] = [];
  setRateLimitEventSink((e) => events.push({ name: e.name, key: e.key }));
  try {
    // 5 failures = email bucket reaches max. Events should fire once for the
    // email limiter (max=5) and zero times for the ip limiter (max=20).
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(fakeReq(ip), email);
    }
    // Extra failures inside the same window must NOT re-fire the sink.
    await recordLoginFailure(fakeReq(ip), email);
    await recordLoginFailure(fakeReq(ip), email);

    const emailEvents = events.filter((e) => e.name === "login:email");
    const ipEvents = events.filter((e) => e.name === "login:ip");
    assert.equal(emailEvents.length, 1, "email sink fires exactly once");
    assert.equal(emailEvents[0].key, `email:${email}`);
    assert.equal(ipEvents.length, 0, "ip sink should not fire (under max)");
  } finally {
    setRateLimitEventSink(null);
  }
});

test("successful login clears the per-email bucket for that email", async () => {
  const ip = "10.0.0.3";
  const email = "bob@example.com";
  await resetIp(ip);
  await resetEmail(email);

  for (let i = 0; i < 4; i++) {
    await recordLoginFailure(fakeReq(ip), email);
  }
  await recordLoginSuccess(fakeReq(ip), email);

  // Email bucket cleared: should be allowed again immediately.
  const res = fakeRes();
  assert.equal(await checkLoginLimits(fakeReq(ip), res, email), true);
});
