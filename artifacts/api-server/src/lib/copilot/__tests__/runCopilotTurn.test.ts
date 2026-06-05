// Loop-level tests for the Worksheet Copilot agentic turn (Task #451, T010).
//
// Stubs both Claude (the Anthropic client) and the loopback so we can pin
// the turn's control flow without a network or DB:
//   - a plain text reply ends the turn and returns the assistant text
//   - a read tool_use runs the loopback and records a step
//   - a gated tool_use yields a pendingAction and halts the loop (no
//     further tools run behind an unconfirmed action)
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runCopilotTurn, _copilotInternals } from "../runCopilotTurn.js";
import type { LoopbackCall } from "../loopback.js";

type CreateResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
};

/** Build a stub Anthropic client that returns queued responses in order. */
function stubClaude(queue: CreateResult[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const next = queue[Math.min(i, queue.length - 1)];
        i++;
        return next as unknown as Anthropic.Messages.Message;
      },
    },
  } as unknown as Anthropic;
}

function loopback(
  reply: (method: string, path: string) => unknown = () => ({}),
): { call: LoopbackCall; paths: string[] } {
  const paths: string[] = [];
  const call: LoopbackCall = async (method, path) => {
    paths.push(path);
    const json = reply(method, path);
    return { status: 200, ok: true, json, text: JSON.stringify(json) };
  };
  return { call, paths };
}

const baseInput = {
  history: [] as ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
  context: { weekStart: "2024-12-29", kfiId: "1001" },
  user: { id: 1, isAdmin: true },
};

test("a plain text reply ends the turn", async () => {
  const client = stubClaude([
    {
      content: [{ type: "text", text: "Nothing to change." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);
  _copilotInternals.setClaudeClientOverride(client);
  try {
    const { call } = loopback();
    const out = await runCopilotTurn({
      ...baseInput,
      userMessage: "anything to fix?",
      call,
    });
    assert.equal(out.assistantText, "Nothing to change.");
    assert.equal(out.toolSteps.length, 0);
    assert.equal(out.pendingAction, null);
    assert.equal(out.inputTokens, 10);
    assert.equal(out.outputTokens, 5);
  } finally {
    _copilotInternals.setClaudeClientOverride(null);
  }
});

test("a read tool_use runs the loopback and records a step", async () => {
  const client = stubClaude([
    {
      content: [
        { type: "tool_use", id: "t1", name: "get_week_summary", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 8 },
    },
    {
      content: [{ type: "text", text: "All drivers look clean." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 6 },
    },
  ]);
  _copilotInternals.setClaudeClientOverride(client);
  try {
    const { call, paths } = loopback(() => ({ drivers: [] }));
    const out = await runCopilotTurn({
      ...baseInput,
      userMessage: "how's the week?",
      call,
    });
    assert.equal(out.toolSteps.length, 1);
    assert.equal(out.toolSteps[0].tool, "get_week_summary");
    assert.equal(out.toolSteps[0].mutating, false);
    assert.equal(out.pendingAction, null);
    assert.match(paths[0], /\/summary$/);
    assert.equal(out.assistantText, "All drivers look clean.");
  } finally {
    _copilotInternals.setClaudeClientOverride(null);
  }
});

test("a mutation behind a gated action in the same response does NOT execute", async () => {
  // Claude emits, in ONE response: a grounding read, a gated delete, and then
  // a non-gated mutating edit. The delete must queue a pendingAction and the
  // edit must be skipped — nothing may mutate behind an unconfirmed action.
  const client = stubClaude([
    {
      content: [
        { type: "tool_use", id: "r1", name: "get_driver_detail", input: {} },
        {
          type: "tool_use",
          id: "d1",
          name: "delete_punch",
          input: { punchId: 7, reason: "duplicate" },
        },
        {
          type: "tool_use",
          id: "e1",
          name: "edit_punch",
          input: { punchId: 8, clockIn: "08:00", clockOut: "16:00" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 10 },
    },
    {
      content: [{ type: "text", text: "Confirm deleting punch 7 first." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 14, output_tokens: 7 },
    },
  ]);
  _copilotInternals.setClaudeClientOverride(client);
  try {
    const { call, paths } = loopback(() => ({ punches: [] }));
    const out = await runCopilotTurn({
      ...baseInput,
      userMessage: "delete punch 7 and fix punch 8",
      call,
    });
    assert.equal(out.pendingAction?.kind, "delete_punch");
    // Only the read hit loopback. Neither the delete (gated) nor the edit
    // (skipped behind the pending action) made a mutating call.
    assert.equal(paths.length, 1);
    assert.match(paths[0], /\/drivers\//);
    assert.ok(
      !paths.some((p) => /punches\/8/.test(p)),
      "the edit_punch behind the pending action must not execute",
    );
  } finally {
    _copilotInternals.setClaudeClientOverride(null);
  }
});

test("a failed read does NOT ground the turn — a following mutation is refused", async () => {
  // The read returns a non-2xx loopback result (treated as an error outcome),
  // so hasRead must stay false and the subsequent edit_punch must be refused
  // by the read-before-write rail rather than executing.
  const client = stubClaude([
    {
      content: [
        { type: "tool_use", id: "r1", name: "get_driver_detail", input: {} },
        {
          type: "tool_use",
          id: "e1",
          name: "edit_punch",
          input: { punchId: 8, clockIn: "08:00", clockOut: "16:00" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 10 },
    },
    {
      content: [{ type: "text", text: "I couldn't read the driver first." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 14, output_tokens: 7 },
    },
  ]);
  _copilotInternals.setClaudeClientOverride(client);
  try {
    const paths: string[] = [];
    const call: LoopbackCall = async (_method, path) => {
      paths.push(path);
      // Read fails (404); the edit must never be attempted.
      return {
        status: 404,
        ok: false,
        json: { error: "not found" },
        text: '{"error":"not found"}',
      };
    };
    const out = await runCopilotTurn({
      ...baseInput,
      userMessage: "fix punch 8 for that driver",
      call,
    });
    assert.equal(out.pendingAction, null);
    // The read was attempted; the edit must NOT have hit loopback (it was
    // refused by the read-before-write rail because the read failed).
    assert.ok(
      !paths.some((p) => /punches\/8/.test(p)),
      "edit_punch must be refused when no successful read grounded the turn",
    );
  } finally {
    _copilotInternals.setClaudeClientOverride(null);
  }
});

test("a gated tool_use surfaces a pendingAction and halts the loop", async () => {
  const client = stubClaude([
    {
      // One turn: read first (grounds the copilot), then attempt a delete.
      content: [
        { type: "tool_use", id: "r1", name: "get_driver_detail", input: {} },
        {
          type: "tool_use",
          id: "d1",
          name: "delete_punch",
          input: { punchId: 7, reason: "duplicate" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 10 },
    },
    {
      content: [
        { type: "text", text: "Waiting for you to confirm deleting punch 7." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 14, output_tokens: 7 },
    },
  ]);
  _copilotInternals.setClaudeClientOverride(client);
  try {
    const { call, paths } = loopback(() => ({ punches: [] }));
    const out = await runCopilotTurn({
      ...baseInput,
      userMessage: "delete the duplicate punch for that driver",
      call,
    });
    assert.ok(out.pendingAction, "delete must produce a pending action");
    assert.equal(out.pendingAction?.kind, "delete_punch");
    assert.equal(out.pendingAction?.calls[0].method, "DELETE");
    // The read ran; the delete did NOT hit loopback (it gated instead).
    assert.equal(paths.length, 1);
    assert.match(paths[0], /\/drivers\//);
    assert.match(out.assistantText, /confirm/i);
  } finally {
    _copilotInternals.setClaudeClientOverride(null);
  }
});
