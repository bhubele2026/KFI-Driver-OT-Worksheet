import type Anthropic from "@anthropic-ai/sdk";
import type {
  CopilotToolStep,
  CopilotPendingAction,
  CopilotActionResult,
} from "@workspace/db/schema";
import {
  getClaudeClient,
  DEFAULT_CLAUDE_COPILOT_MODEL,
} from "../parsers/claude.js";
import { costUsd } from "../parsers/pricing.js";
import type { LoopbackCall } from "./loopback.js";
import {
  buildCopilotToolDefs,
  runCopilotTool,
  ToolBudget,
  type CopilotToolCtx,
} from "./tools.js";

/**
 * Task #451 (T004): the agentic loop behind the global Worksheet Copilot.
 *
 * Mirrors the per-customer upload chat loop (`chat/claudeChat.ts`) but is
 * scoped to a signed-in user rather than a (week, customer) pair, runs a
 * larger multi-step budget, and drives the read/mutation tool layer in
 * `copilot/tools.ts`. Every mutating tool is executed through an
 * authenticated in-process loopback call, so all existing guards / audit /
 * attribution paths are reused with no business logic duplicated here.
 *
 * Destructive or bulk actions are not executed inside the loop — the tool
 * returns a `pendingAction` and the loop stops, surfacing a confirmation
 * card to the dispatcher. On confirm, the route replays the action via
 * {@link executePendingAction}.
 */

export const COPILOT_MODEL =
  process.env.CLAUDE_COPILOT_MODEL ?? DEFAULT_CLAUDE_COPILOT_MODEL;
const MAX_TOOL_TURNS = 12;
const MAX_OUTPUT_TOKENS = 4_096;
const TURN_TIMEOUT_MS = 120_000;

export interface CopilotTurnInput {
  /** Prior messages on the conversation, oldest first. */
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  /** The new dispatcher message. */
  userMessage: string;
  /** Default scope the dispatcher is currently looking at. */
  context: { weekStart?: string | null; kfiId?: string | null };
  /** The signed-in dispatcher driving the conversation. */
  user: { id: number; isAdmin: boolean };
  /** Authenticated loopback bound to the dispatcher's session cookie. */
  call: LoopbackCall;
}

export interface CopilotTurnResult {
  assistantText: string;
  /** Ordered trail of every tool the assistant ran this turn. */
  toolSteps: CopilotToolStep[];
  /** A confirmation-gated action awaiting the dispatcher, if any. */
  pendingAction: CopilotPendingAction | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Test seam: swap a stub Anthropic client (restore with `null`). */
let claudeClientOverride: Anthropic | null = null;
function setClaudeClientOverride(c: Anthropic | null): void {
  claudeClientOverride = c;
}

export async function runCopilotTurn(
  input: CopilotTurnInput,
): Promise<CopilotTurnResult> {
  const client = claudeClientOverride ?? getClaudeClient();
  const tools = buildCopilotToolDefs();
  const system = buildSystemPrompt(input.context, input.user);

  const budget = new ToolBudget();
  const steps: CopilotToolStep[] = [];
  const toolCtx: CopilotToolCtx = {
    call: input.call,
    context: input.context,
    user: input.user,
    budget,
    steps,
    hasRead: false,
  };

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const h of input.history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: "user", content: input.userMessage });

  let assistantText = "";
  let pendingAction: CopilotPendingAction | null = null;
  let totalIn = 0;
  let totalOut = 0;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await client.messages.create(
      {
        model: COPILOT_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools,
        messages,
      },
      { timeout: TURN_TIMEOUT_MS },
    );
    totalIn += response.usage?.input_tokens ?? 0;
    totalOut += response.usage?.output_tokens ?? 0;

    const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        assistantText += (assistantText ? "\n\n" : "") + block.text;
      } else if (block.type === "tool_use") {
        toolUses.push(block);
      }
    }

    if (toolUses.length === 0 || response.stop_reason === "end_turn") {
      break;
    }

    // Echo the assistant turn back so Claude sees its own tool calls.
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      // Once a gated action is queued this turn, do NOT execute any further
      // tool the model emitted in the same response — a destructive action
      // is awaiting confirmation and nothing else may mutate behind it. We
      // still emit a benign tool_result for each remaining tool_use so the
      // one-result-per-tool_use API contract stays valid; the outer loop
      // breaks immediately after this block.
      if (pendingAction) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content:
            "Skipped: a prior action this turn is awaiting the dispatcher's confirmation. Do not run more tools.",
          is_error: false,
        });
        continue;
      }
      const outcome = await runCopilotTool(
        tu.name,
        (tu.input ?? {}) as Record<string, unknown>,
        toolCtx,
      );
      if (outcome.pending) {
        pendingAction = outcome.pending;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: outcome.resultText,
        is_error: outcome.isError ?? false,
      });
    }
    messages.push({ role: "user", content: toolResults });

    // A gated action is awaiting the dispatcher — give Claude one more
    // turn to narrate it, then stop. We break here so the loop can't
    // execute anything further behind the pending confirmation.
    if (pendingAction) {
      const finalResp = await client.messages.create(
        {
          model: COPILOT_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools,
          messages,
        },
        { timeout: TURN_TIMEOUT_MS },
      );
      totalIn += finalResp.usage?.input_tokens ?? 0;
      totalOut += finalResp.usage?.output_tokens ?? 0;
      for (const block of finalResp.content) {
        if (block.type === "text") {
          assistantText += (assistantText ? "\n\n" : "") + block.text;
        }
      }
      break;
    }
  }

  return {
    assistantText: assistantText.trim() || "(no reply)",
    toolSteps: steps,
    pendingAction,
    model: COPILOT_MODEL,
    inputTokens: totalIn,
    outputTokens: totalOut,
    costUsd: costUsd(COPILOT_MODEL, totalIn, totalOut),
  };
}

/**
 * Replay a confirmed {@link CopilotPendingAction}'s loopback calls in
 * order. Used by the confirm/execute endpoint after the dispatcher
 * approves a gated action. Each call goes back through the same
 * authenticated `/api` surface, so every guard / audit / snapshot path
 * runs exactly as if the dispatcher had clicked the button.
 */
export async function executePendingAction(
  call: LoopbackCall,
  action: CopilotPendingAction,
): Promise<CopilotActionResult> {
  const results: CopilotActionResult["results"] = [];
  let allOk = true;
  for (const c of action.calls) {
    let ok = false;
    let status = 0;
    let detail: string | undefined;
    try {
      const r = await call(c.method, c.path, c.body);
      ok = r.ok;
      status = r.status;
      if (!r.ok) {
        const errField =
          r.json &&
          typeof r.json === "object" &&
          "error" in r.json &&
          typeof (r.json as { error: unknown }).error === "string"
            ? (r.json as { error: string }).error
            : undefined;
        detail = errField ?? r.text ?? undefined;
      }
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    if (!ok) allOk = false;
    results.push({ label: c.label, status, ok, detail });
    // Stop on the first failure so a partial multi-step action doesn't
    // keep mutating after something went wrong.
    if (!ok) break;
  }
  return { ok: allOk, results };
}

function buildSystemPrompt(
  context: { weekStart?: string | null; kfiId?: string | null },
  user: { id: number; isAdmin: boolean },
): string {
  const scope: string[] = [];
  if (context.weekStart) {
    scope.push(`Current payroll week: ${context.weekStart} (a Sunday).`);
  } else {
    scope.push(`No week is in context — ask which week, or read list_weeks.`);
  }
  if (context.kfiId) {
    scope.push(`Current driver in view: ${context.kfiId}.`);
  }
  scope.push(
    user.isAdmin
      ? `The dispatcher is an admin (admin-only tools are available).`
      : `The dispatcher is NOT an admin — admin-only tools (e.g. driver-id aliases, ingestion runs) will be refused.`,
  );
  return [
    `You are the Worksheet Copilot inside the KFI Driver OT Worksheet — a serious payroll-reconciliation tool. You help a dispatcher read AND change the worksheet for ~21 KFI drivers in plain language. Treat them as a busy coworker: terse, factual, no pleasantries, no emojis.`,
    ``,
    `## Scope`,
    ...scope.map((s) => `- ${s}`),
    ``,
    `## Read before you write`,
    `Tools are the source of truth, not the dispatcher's memory. Before ANY mutation, read the relevant state first — get_week_summary for a week, get_driver_detail for one driver-week (it has the punch ids you'll need). Resolve any driver named in plain language with lookup_driver to get the kfiId before acting; only call get_driver_roster to scan the whole list. Never guess a punchId or kfiId — read it.`,
    ``,
    `## Making changes`,
    `- Add time with add_manual_punch (one row) or bulk_add_punches (a whole pasted schedule — resolve every name to a kfiId first).`,
    `- Edit a punch's times or override its daily hours with edit_punch; scale_hours / reset_hours adjust a day's total; shift_punches nudges every punch in a driver-week by whole hours (offsetHours, -12..12).`,
    `- mark_reviewed, set_lock (lock/unlock a driver-week), add_note (notes attach to a specific punchId), set_driver_customer_override, add_driver_id_alias.`,
    `- delete_punch, refresh_connecteam_week, and remove_connecteam_time are destructive and ALWAYS require the dispatcher's confirmation; a large bulk_add_punches does too. When a tool returns "queued for confirmation", say in ONE short sentence what will happen and that you're waiting — then STOP. Do not call more tools.`,
    ``,
    `## Conventions`,
    `- Payroll week is Sunday → Saturday; week start dates are always a Sunday (YYYY-MM-DD).`,
    `- Times: "H:MM AM" / "H:MM PM" (24-hour also accepted; the server normalises).`,
    `- A locked driver-week refuses edits (HTTP 409) — tell the dispatcher to unlock it (or offer set_lock) instead of retrying.`,
    ``,
    `## Voice`,
    `Open with the finding or the result, never with "I'll…", "Let me…", "Sure!", or "Happy to…". State what you found or did; don't narrate your tool calls. If the dispatcher asks something off-scope (refunds, accounts, code), say so in one sentence and stop.`,
  ].join("\n");
}

export const _copilotInternals = {
  setClaudeClientOverride,
  buildSystemPrompt,
  MAX_TOOL_TURNS,
};
