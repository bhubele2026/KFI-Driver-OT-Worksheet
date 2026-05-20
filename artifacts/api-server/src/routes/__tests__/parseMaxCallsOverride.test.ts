/**
 * Task #356 — unit coverage for the admin-only `?maxCalls=N` override
 * helper used by the customer-file extract routes.
 *
 * Pins the contract:
 *   - missing/empty param → null (no audit, default ceiling).
 *   - non-admin caller → 403 + "invalid" sentinel.
 *   - non-integer or out-of-range → 400 + "invalid".
 *   - admin + clean integer in [MIN, BACKSTOP] → the validated number.
 *
 * The helper writes its error response through the supplied Express
 * `res`, so the test uses a tiny stub that captures `status` + `json`
 * calls without spinning up a full HTTP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import { parseMaxCallsOverride } from "../weeks.js";
import {
  BACKSTOP_MAX_CALLS_PER_UPLOAD,
  MIN_MAX_CALLS_PER_UPLOAD,
} from "../../lib/parsers/ingestionBudget.js";

function makeRes(): {
  res: Response;
  calls: { status: number | null; body: unknown };
} {
  const calls = { status: null as number | null, body: undefined as unknown };
  const res = {
    status(code: number) {
      calls.status = code;
      return this;
    },
    json(body: unknown) {
      calls.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, calls };
}

function makeReq(
  maxCalls: string | undefined,
  user: { isAdmin: boolean } | null,
): Request {
  return {
    query: maxCalls === undefined ? {} : { maxCalls },
    user,
  } as unknown as Request;
}

test("maxCalls absent → null (no override, no audit)", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq(undefined, { isAdmin: true }),
    res,
  );
  assert.equal(out, null);
  assert.equal(calls.status, null);
});

test("maxCalls empty string → null", () => {
  const { res } = makeRes();
  assert.equal(
    parseMaxCallsOverride(makeReq("", { isAdmin: true }), res),
    null,
  );
});

test("non-admin caller with maxCalls present → 403", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq("200", { isAdmin: false }),
    res,
  );
  assert.equal(out, "invalid");
  assert.equal(calls.status, 403);
});

test("anonymous caller with maxCalls present → 403", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(makeReq("200", null), res);
  assert.equal(out, "invalid");
  assert.equal(calls.status, 403);
});

test("admin + non-integer ('200abc') → 400", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq("200abc", { isAdmin: true }),
    res,
  );
  assert.equal(out, "invalid");
  assert.equal(calls.status, 400);
});

test("admin + decimal ('1.5') → 400", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq("1.5", { isAdmin: true }),
    res,
  );
  assert.equal(out, "invalid");
  assert.equal(calls.status, 400);
});

test("admin + below floor → 400", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq(String(MIN_MAX_CALLS_PER_UPLOAD - 1), { isAdmin: true }),
    res,
  );
  assert.equal(out, "invalid");
  assert.equal(calls.status, 400);
});

test("admin + above backstop → 400", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq(String(BACKSTOP_MAX_CALLS_PER_UPLOAD + 1), { isAdmin: true }),
    res,
  );
  assert.equal(out, "invalid");
  assert.equal(calls.status, 400);
});

test("admin + clean integer at backstop → number", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq(String(BACKSTOP_MAX_CALLS_PER_UPLOAD), { isAdmin: true }),
    res,
  );
  assert.equal(out, BACKSTOP_MAX_CALLS_PER_UPLOAD);
  assert.equal(calls.status, null);
});

test("admin + clean integer at floor → number", () => {
  const { res, calls } = makeRes();
  const out = parseMaxCallsOverride(
    makeReq(String(MIN_MAX_CALLS_PER_UPLOAD), { isAdmin: true }),
    res,
  );
  assert.equal(out, MIN_MAX_CALLS_PER_UPLOAD);
  assert.equal(calls.status, null);
});
