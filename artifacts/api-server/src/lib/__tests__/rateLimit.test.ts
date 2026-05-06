import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  checkLoginLimits,
  loginEmailLimiter,
  loginIpLimiter,
  recordLoginFailure,
  recordLoginSuccess,
} from "../rateLimit.js";

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

function resetIp(ip: string) {
  loginIpLimiter.reset(`ip:${ip}`);
}
function resetEmail(email: string) {
  loginEmailLimiter.reset(`email:${email}`);
}

test("per-email limiter blocks after 5 failures and 429s on the 6th", () => {
  const ip = "10.0.0.1";
  const email = "alice@example.com";
  resetIp(ip);
  resetEmail(email);

  for (let i = 0; i < 5; i++) {
    const res = fakeRes();
    assert.equal(checkLoginLimits(fakeReq(ip), res, email), true);
    recordLoginFailure(fakeReq(ip), email);
  }
  const res = fakeRes();
  const ok = checkLoginLimits(fakeReq(ip), res, email);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers["Retry-After"]);
});

test("successful login does NOT clear prior IP failures", () => {
  const ip = "10.0.0.2";
  const attacker = "victim@example.com";
  const valid = "attacker-owned@example.com";
  resetIp(ip);
  resetEmail(attacker);
  resetEmail(valid);

  // Burn most of the per-IP budget (20/15min) attacking the victim email,
  // staying under the per-email cap (5) by spreading across multiple emails.
  for (let i = 0; i < 19; i++) {
    recordLoginFailure(fakeReq(ip), `decoy${i}@example.com`);
  }

  // Attacker successfully logs into a valid account they own.
  recordLoginSuccess(fakeReq(ip), valid);

  // Per-email reset for the successful email is fine, but the IP bucket
  // must still reflect prior failures. The 20th IP failure should be the
  // last allowed attempt; the 21st must be 429.
  const r1 = fakeRes();
  assert.equal(checkLoginLimits(fakeReq(ip), r1, attacker), true);
  recordLoginFailure(fakeReq(ip), attacker);

  const r2 = fakeRes();
  const ok = checkLoginLimits(fakeReq(ip), r2, attacker);
  assert.equal(ok, false, "IP bucket should still be exhausted after success");
  assert.equal(r2.statusCode, 429);
});

test("successful login clears the per-email bucket for that email", () => {
  const ip = "10.0.0.3";
  const email = "bob@example.com";
  resetIp(ip);
  resetEmail(email);

  for (let i = 0; i < 4; i++) {
    recordLoginFailure(fakeReq(ip), email);
  }
  recordLoginSuccess(fakeReq(ip), email);

  // Email bucket cleared: should be allowed again immediately.
  const res = fakeRes();
  assert.equal(checkLoginLimits(fakeReq(ip), res, email), true);
});
