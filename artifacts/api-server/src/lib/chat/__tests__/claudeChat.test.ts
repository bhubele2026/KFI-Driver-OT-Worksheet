import test from "node:test";
import assert from "node:assert/strict";
import { _internals } from "../claudeChat.js";

/**
 * Task #406 (T007): deterministic coverage for the Claude chat tool
 * layer's propose-* tools. The read tools touch the DB so they're
 * covered by the apply-flow e2e spec; here we lock in the structured
 * payload shape every propose tool emits so the apply route never sees
 * a malformed `proposedFix`.
 *
 * We invoke `runTool` directly with a synthetic Anthropic
 * `ToolUseBlock` — no API key, no SDK calls.
 */

function call(name: string, input: Record<string, unknown>) {
  return _internals.runTool(
    {
      type: "tool_use",
      id: "tu_test",
      name,
      input,
    } as unknown as Parameters<typeof _internals.runTool>[0],
    { weekStart: "2026-01-04", customer: "Acme" },
  );
}

test("propose_add_punches: requires lessonText + ≥1 punch", async () => {
  const empty = await call("propose_add_punches", {
    punches: [],
    lessonText: "x",
  });
  assert.equal(empty.isError, true);
  const noLesson = await call("propose_add_punches", {
    punches: [{ kfiId: "100", date: "2026-01-05", clockIn: "7:00 AM", clockOut: "3:00 PM" }],
    lessonText: "",
  });
  assert.equal(noLesson.isError, true);
});

test("propose_add_punches: normalizes payload + carries lesson", async () => {
  const r = await call("propose_add_punches", {
    punches: [
      {
        kfiId: "100",
        date: "2026-01-05",
        clockIn: "7:00 AM",
        clockOut: "3:00 PM",
        payType: "Reg",
        notes: "first run",
      },
    ],
    lessonText: "Acme always shows Reg, never blank.",
  });
  assert.ok(r.proposal, "expected a proposal");
  assert.equal(r.proposal!.fix.kind, "addPunches");
  assert.equal(r.proposal!.lesson, "Acme always shows Reg, never blank.");
  assert.deepEqual(
    (r.proposal!.fix as { punches: unknown[] }).punches[0],
    {
      kfiId: "100",
      date: "2026-01-05",
      clockIn: "7:00 AM",
      clockOut: "3:00 PM",
      payType: "Reg",
      notes: "first run",
    },
  );
});

test("propose_edit_punch: only carries fields the dispatcher set", async () => {
  const r = await call("propose_edit_punch", {
    punchId: 42,
    hours: 8.25,
    lessonText: "Acme's 7:30 punch is actually 7:15.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as {
    kind: string;
    punchId: number;
    hours?: number;
    clockIn?: string;
  };
  assert.equal(fix.kind, "editPunch");
  assert.equal(fix.punchId, 42);
  assert.equal(fix.hours, 8.25);
  assert.equal(fix.clockIn, undefined);
});

test("propose_edit_punch: rejects non-integer punchId", async () => {
  const r = await call("propose_edit_punch", {
    punchId: "forty-two",
    lessonText: "x",
  });
  assert.equal(r.isError, true);
});

test("propose_delete_punch: requires punchId + reason + lesson", async () => {
  const r = await call("propose_delete_punch", {
    punchId: 7,
    reason: "Duplicate",
    lessonText: "Acme files duplicate the lunch break.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as { kind: string; reason: string };
  assert.equal(fix.kind, "deletePunch");
  assert.equal(fix.reason, "Duplicate");

  const bad = await call("propose_delete_punch", { punchId: 7, reason: "", lessonText: "x" });
  assert.equal(bad.isError, true);
});

test("propose_add_driver_alias: trims inputs and produces alias fix", async () => {
  const r = await call("propose_add_driver_alias", {
    nameOnDoc: "  J. Smith ",
    kfiId: "100",
    lessonText: "Acme uses initials.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as {
    kind: string;
    nameOnDoc: string;
    kfiId: string;
  };
  assert.equal(fix.kind, "addDriverAlias");
  assert.equal(fix.nameOnDoc, "J. Smith");
  assert.equal(fix.kfiId, "100");
});

test("propose_re_extract_with_hint: hint+lesson required, sampleId optional", async () => {
  const r = await call("propose_re_extract_with_hint", {
    hint: "Date column is at index 3, not 2.",
    sampleId: 999,
    lessonText: "Acme's date column moved.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as { kind: string; hint: string; sampleId?: number };
  assert.equal(fix.kind, "reExtractWithHint");
  assert.equal(fix.sampleId, 999);

  const bad = await call("propose_re_extract_with_hint", { hint: "", lessonText: "x" });
  assert.equal(bad.isError, true);
});

test("unknown tool name returns an error result", async () => {
  const r = await call("propose_buy_lunch", { lessonText: "x" });
  assert.equal(r.isError, true);
});
