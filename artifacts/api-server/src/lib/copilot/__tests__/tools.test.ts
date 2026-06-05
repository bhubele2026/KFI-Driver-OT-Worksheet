// Unit tests for the Worksheet Copilot tool layer (Task #451, T010).
//
// These pin the safety contracts that keep the agentic copilot from doing
// anything the dispatcher couldn't do — and from doing destructive/bulk
// things without an explicit confirmation:
//   - read-before-write: a mutation refuses until a read has grounded it
//   - admin-only tools refuse for non-admins
//   - per-turn tool-call budget caps runaway loops
//   - destructive tools (delete/refresh-week/remove-CT) ALWAYS gate
//   - bulk_add_punches gates over the threshold, executes under it
//   - executePendingAction stops on the first failed call
//
// No DB and no Claude: the loopback is a stub, so these run anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCopilotTool,
  ToolBudget,
  COPILOT_MAX_TOOL_CALLS,
  COPILOT_BULK_CONFIRM_THRESHOLD,
  _toolInternals,
  type CopilotToolCtx,
} from "../tools.js";
import { executePendingAction } from "../runCopilotTurn.js";
import type { LoopbackCall, LoopbackResult } from "../loopback.js";
import type { CopilotToolStep } from "@workspace/db/schema";

const WEEK = "2024-12-29"; // a Sunday
const KFI = "1001";

function ok(json: unknown = {}): LoopbackResult {
  return { status: 200, ok: true, json, text: JSON.stringify(json) };
}
function fail(status = 409, error = "locked"): LoopbackResult {
  return { status, ok: false, json: { error }, text: JSON.stringify({ error }) };
}

/** A loopback stub that records every call and replies from a queue/fn. */
function stubCall(
  reply: (method: string, path: string, body?: unknown) => LoopbackResult,
): { call: LoopbackCall; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const call: LoopbackCall = async (method, path, body) => {
    calls.push({ method, path, body });
    return reply(method, path, body);
  };
  return { call, calls };
}

function makeCtx(opts?: {
  call?: LoopbackCall;
  isAdmin?: boolean;
  hasRead?: boolean;
  budget?: ToolBudget;
}): CopilotToolCtx {
  const steps: CopilotToolStep[] = [];
  return {
    call: opts?.call ?? (async () => ok()),
    context: { weekStart: WEEK, kfiId: KFI },
    user: { id: 1, isAdmin: opts?.isAdmin ?? true },
    budget: opts?.budget ?? new ToolBudget(),
    steps,
    hasRead: opts?.hasRead ?? false,
  };
}

test("read-before-write: a mutation refuses until a read has run", async () => {
  const { call, calls } = stubCall(() => ok());
  const ctx = makeCtx({ call, hasRead: false });
  const out = await runCopilotTool(
    "add_manual_punch",
    { date: "2024-12-31", clockIn: "7:00a", clockOut: "3:00p" },
    ctx,
  );
  assert.equal(out.isError, true);
  assert.equal(out.mutating, true);
  assert.match(out.resultText, /read the relevant data first/i);
  // The guard must trip BEFORE any loopback call is made.
  assert.equal(calls.length, 0);
});

test("a read tool flips hasRead so a following mutation is allowed", async () => {
  const { call } = stubCall((method, path) => {
    if (path.includes("/summary")) return ok({ drivers: [] });
    return ok({ id: 99 });
  });
  const ctx = makeCtx({ call, hasRead: false });

  const read = await runCopilotTool("get_week_summary", {}, ctx);
  assert.equal(read.isError, undefined);
  assert.equal(ctx.hasRead, true);

  const mut = await runCopilotTool(
    "add_manual_punch",
    { date: "2024-12-31", clockIn: "7:00a", clockOut: "3:00p" },
    ctx,
  );
  assert.notEqual(mut.isError, true);
  assert.equal(mut.mutating, true);
});

test("admin-only tools refuse for non-admins (before read-before-write)", async () => {
  const ctx = makeCtx({ isAdmin: false, hasRead: false });
  const out = await runCopilotTool(
    "add_driver_id_alias",
    { externalId: "X1", kfiId: KFI },
    ctx,
  );
  assert.equal(out.isError, true);
  assert.match(out.resultText, /admin-only/i);
});

test("admin tool set is exactly the privileged ones", () => {
  assert.deepEqual(
    [..._toolInternals.ADMIN_TOOLS].sort(),
    ["add_driver_id_alias", "get_ingestion_runs"].sort(),
  );
});

test("the tool-call budget caps a runaway turn", async () => {
  const budget = new ToolBudget();
  budget.callsUsed = COPILOT_MAX_TOOL_CALLS;
  const ctx = makeCtx({ hasRead: true, budget });
  const out = await runCopilotTool("get_week_summary", {}, ctx);
  assert.equal(out.isError, true);
  assert.match(out.resultText, /budget exhausted/i);
});

test("every gated tool returns a pendingAction and never touches loopback", async () => {
  for (const tool of _toolInternals.GATED_TOOLS) {
    const { call, calls } = stubCall(() => ok());
    const ctx = makeCtx({ call, hasRead: true });
    const input: Record<string, unknown> =
      tool === "delete_punch" ? { punchId: 5, reason: "dup" } : {};
    const out = await runCopilotTool(tool, input, ctx);
    assert.ok(out.pending, `${tool} should return a pendingAction`);
    assert.equal(out.pending?.kind, tool);
    assert.ok(out.pending && out.pending.calls.length > 0);
    // Gating must not execute anything inline.
    assert.equal(calls.length, 0, `${tool} must not call loopback when gated`);
  }
});

test("delete_punch gates a DELETE call behind confirmation", async () => {
  const { call, calls } = stubCall(() => ok());
  const ctx = makeCtx({ call, hasRead: true });
  const out = await runCopilotTool(
    "delete_punch",
    { punchId: 42, reason: "duplicate" },
    ctx,
  );
  assert.ok(out.pending);
  assert.equal(out.pending?.calls[0].method, "DELETE");
  assert.match(out.pending!.calls[0].path, /\/api\/punches\/42$/);
  assert.equal(calls.length, 0);
});

test("bulk_add_punches gates when over the confirm threshold", async () => {
  const { call, calls } = stubCall(() => ok());
  const ctx = makeCtx({ call, hasRead: true });
  const punches = Array.from(
    { length: COPILOT_BULK_CONFIRM_THRESHOLD + 1 },
    (_, i) => ({
      kfiId: KFI,
      date: "2024-12-31",
      clockIn: "7:00a",
      clockOut: `${1 + i}:00p`,
    }),
  );
  const out = await runCopilotTool("bulk_add_punches", { punches }, ctx);
  assert.ok(out.pending, "over-threshold bulk add must gate");
  assert.equal(out.pending?.kind, "bulk_add_punches");
  assert.equal(out.pending?.calls.length, punches.length);
  assert.equal(calls.length, 0, "gated bulk add must not execute inline");
});

test("bulk_add_punches executes inline when under the threshold", async () => {
  const { call, calls } = stubCall(() => ok({ id: 1 }));
  const ctx = makeCtx({ call, hasRead: true });
  const punches = [
    { kfiId: KFI, date: "2024-12-31", clockIn: "7:00a", clockOut: "3:00p" },
    { kfiId: KFI, date: "2025-01-01", clockIn: "7:00a", clockOut: "3:00p" },
  ];
  const out = await runCopilotTool("bulk_add_punches", { punches }, ctx);
  assert.equal(out.pending, undefined, "under-threshold bulk add runs inline");
  assert.notEqual(out.isError, true);
  assert.equal(calls.length, 2, "each punch is one manual-punch POST");
  for (const c of calls) {
    assert.equal(c.method, "POST");
    assert.match(c.path, /\/manual-punches$/);
  }
});

test("a locked-week 409 from loopback surfaces as a clear tool error", async () => {
  const { call } = stubCall(() => fail(409, "driver-week is locked"));
  const ctx = makeCtx({ call, hasRead: true });
  const out = await runCopilotTool(
    "mark_reviewed",
    { status: "good" },
    ctx,
  );
  assert.equal(out.isError, true);
  assert.match(out.resultText, /409|locked/i);
});

test("executePendingAction stops on the first failed call", async () => {
  const seen: string[] = [];
  const call: LoopbackCall = async (_method, path) => {
    seen.push(path);
    // first ok, second fails, third should never run
    if (seen.length === 2) return fail(422, "bad row");
    return ok();
  };
  const result = await executePendingAction(call, {
    kind: "bulk_add_punches",
    title: "Add 3 punches",
    summary: ["a", "b", "c"],
    calls: [
      { method: "POST", path: "/api/a", label: "a" },
      { method: "POST", path: "/api/b", label: "b" },
      { method: "POST", path: "/api/c", label: "c" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 2, "must stop after the first failure");
  assert.equal(seen.length, 2, "must not run calls after a failure");
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.match(result.results[1].detail ?? "", /bad row/);
});

test("executePendingAction reports all-ok when every call succeeds", async () => {
  const { call, calls } = stubCall(() => ok());
  const result = await executePendingAction(call, {
    kind: "delete_punch",
    title: "Delete punch 1",
    summary: ["Delete punch 1"],
    calls: [{ method: "DELETE", path: "/api/punches/1", label: "delete 1" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(calls.length, 1);
});
