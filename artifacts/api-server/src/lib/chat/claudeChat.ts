import { and, eq, sql, desc, asc } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db, schema } from "../db.js";
import { logger } from "../logger.js";
import {
  getClaudeClient,
  DEFAULT_CLAUDE_MODEL,
} from "../parsers/claude.js";
import { loadLessonsForPrompt } from "./lessonsStore.js";
import type { ProposedFix } from "@workspace/db/schema";

/**
 * Task #406 (T003): the Claude chat tool layer.
 *
 * One chat thread per (week, customer). Each user turn runs a bounded
 * Claude tool loop: Claude can call read-only tools to inspect the
 * current state (punches, roster, lessons, original file) and exactly
 * one `propose*` tool to suggest a structured fix the dispatcher can
 * Apply or Dismiss. The propose-tool inputs all include a `lessonText`
 * the dispatcher can save when applying so the next extraction for
 * this customer doesn't repeat the same mistake.
 *
 * The loop is Claude-only — there's no Gemini fallback here, by
 * design: a misrouted tool call would silently corrupt payroll. If
 * `ANTHROPIC_API_KEY` is unset the route returns 400 with the same
 * message the AI extractor uses.
 */

const CHAT_MODEL = process.env.CLAUDE_CHAT_MODEL ?? DEFAULT_CLAUDE_MODEL;
const MAX_TOOL_TURNS = 6;
const MAX_OUTPUT_TOKENS = 2_048;
const TURN_TIMEOUT_MS = 60_000;

export interface ChatTurnInput {
  weekStart: string;
  customer: string;
  /**
   * All prior messages on the thread in chronological order, oldest
   * first. The route reads these from `customer_upload_chat_messages`
   * and rebuilds the conversation context on every turn (no
   * Anthropic-side conversation state).
   */
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  /** The new user message the dispatcher just typed. */
  userMessage: string;
}

export interface ChatTurnResult {
  /** Claude's prose reply to the dispatcher. */
  assistantText: string;
  /** The proposed fix (if Claude called a propose-tool). */
  proposedFix: ProposedFix | null;
  /** The lesson text Claude attached to the proposed fix, if any. */
  proposedLesson: string | null;
  /** Diagnostics for the chat audit row. */
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

interface ToolCallRecord {
  name: string;
  input: unknown;
}

/**
 * Run one user-turn through Claude. The route is responsible for
 * persisting the user message BEFORE calling this (so the read tools
 * can see history) and for persisting the assistant reply AFTER.
 */
export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const client = getClaudeClient(); // throws with a clear message if key missing.
  const tools = buildToolDefs();
  const system = await buildSystemPrompt(input.weekStart, input.customer);

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const h of input.history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: "user", content: input.userMessage });

  let proposedFix: ProposedFix | null = null;
  let proposedLesson: string | null = null;
  let assistantText = "";
  let toolCallCount = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await client.messages.create(
      {
        model: CHAT_MODEL,
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

    // Echo the assistant turn back into the conversation so Claude
    // sees its own tool calls on the next iteration.
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCallCount++;
      const handled = await runTool(tu, input);
      if (handled.proposal) {
        // Latest propose-tool call wins if Claude calls more than one.
        proposedFix = handled.proposal.fix;
        proposedLesson = handled.proposal.lesson;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: handled.resultText,
        is_error: handled.isError ?? false,
      });
    }
    messages.push({ role: "user", content: toolResults });

    // Stop loop after a propose-tool — we have a structured payload to
    // show the dispatcher, no point burning more turns on prose.
    if (proposedFix) break;
  }

  return {
    assistantText: assistantText.trim() || "(no reply)",
    proposedFix,
    proposedLesson,
    toolCallCount,
    inputTokens: totalIn,
    outputTokens: totalOut,
  };
}

async function buildSystemPrompt(
  weekStart: string,
  customer: string,
): Promise<string> {
  const lessons = await loadLessonsForPrompt(customer);
  const lessonLines =
    lessons.length === 0
      ? []
      : [
          ``,
          `## Lessons already saved for this customer`,
          ...lessons.map((l) => `- ${l}`),
        ];
  return [
    `You are an in-app assistant embedded in the KFI Driver OT Worksheet — a payroll-reconciliation tool. The dispatcher has opened a chat scoped to a single customer-week: customer "${customer}", payroll week starting ${weekStart}.`,
    ``,
    `## Your job`,
    `Help the dispatcher fix problems with this customer's uploaded timecard for this week. Typical fixes:`,
    `- A driver is missing punches for one day → propose adding punches.`,
    `- A punch is wrong (clock time, hours, date) → propose editing or deleting it.`,
    `- The file labels a driver by an unrecognised name → propose saving a new alias.`,
    `- The whole extraction came back garbled and you can see the right answer → propose re-extracting with a textual hint and a saved lesson.`,
    ``,
    `## Rules`,
    `1. Always inspect the current state with the read tools before proposing a fix. Never guess at punch ids — get them from \`get_current_punches\`.`,
    `2. Only call ONE propose tool per turn. Stop talking after you call it; the dispatcher will review and Apply or Dismiss.`,
    `3. Every propose tool requires a \`lessonText\` — a one-sentence rule the AI extractor should remember next time. Keep it specific to this customer and free of dispatcher names / dates.`,
    `4. Never propose changes to a DIFFERENT customer or week than the one in scope.`,
    `5. Times use the format "H:MM AM" or "H:MM PM" (24-hour is fine too; the server normalises). Dates use YYYY-MM-DD inside the week ${weekStart} … ${weekStart} + 6 days.`,
    `6. If the dispatcher asks something you cannot help with (refunds, accounts, code questions), say so briefly and stop.`,
    ...lessonLines,
  ].join("\n");
}

function buildToolDefs(): Anthropic.Messages.Tool[] {
  return [
    {
      name: "get_current_punches",
      description:
        "Return every punch currently stored for the customer-week in scope, including punch ids the propose tools need.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_driver_roster",
      description:
        "Return the KFI driver roster (id, name, badge ids, customer aliases) so you can match a name-on-doc to a kfiId.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_existing_lessons",
      description:
        "Return the active extraction lessons already saved for this customer so you don't propose a duplicate.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_last_upload_file_info",
      description:
        "Return metadata about the most recent customer-file upload for this customer-week (filename, mimeType, size, sampleId, uploadedAt). The actual file bytes are not exposed here — propose `re_extract_with_hint` with the sampleId if a re-extract is needed.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "propose_add_punches",
      description:
        "Propose adding one or more manual punches. Each punch must include kfiId, date (YYYY-MM-DD within the week), clockIn, clockOut.",
      input_schema: {
        type: "object",
        properties: {
          punches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kfiId: { type: "string" },
                date: { type: "string" },
                clockIn: { type: "string" },
                clockOut: { type: "string" },
                payType: { type: "string", enum: ["Reg", "OT"] },
                notes: { type: "string" },
              },
              required: ["kfiId", "date", "clockIn", "clockOut"],
            },
          },
          lessonText: { type: "string" },
        },
        required: ["punches", "lessonText"],
      },
    },
    {
      name: "propose_edit_punch",
      description:
        "Propose editing an existing punch by id. Provide only the fields to change.",
      input_schema: {
        type: "object",
        properties: {
          punchId: { type: "integer" },
          clockIn: { type: "string" },
          clockOut: { type: "string" },
          date: { type: "string" },
          hours: { type: "number" },
          lessonText: { type: "string" },
        },
        required: ["punchId", "lessonText"],
      },
    },
    {
      name: "propose_delete_punch",
      description:
        "Propose deleting an existing punch by id. Include a short reason.",
      input_schema: {
        type: "object",
        properties: {
          punchId: { type: "integer" },
          reason: { type: "string" },
          lessonText: { type: "string" },
        },
        required: ["punchId", "reason", "lessonText"],
      },
    },
    {
      name: "propose_add_driver_alias",
      description:
        "Propose saving a (name-on-doc, kfiId) alias so future uploads for this customer auto-resolve the name.",
      input_schema: {
        type: "object",
        properties: {
          nameOnDoc: { type: "string" },
          kfiId: { type: "string" },
          lessonText: { type: "string" },
        },
        required: ["nameOnDoc", "kfiId", "lessonText"],
      },
    },
    {
      name: "propose_re_extract_with_hint",
      description:
        "Propose re-running the AI extractor on the most recent sample file with a textual hint and a saved lesson.",
      input_schema: {
        type: "object",
        properties: {
          hint: { type: "string" },
          sampleId: { type: "integer" },
          lessonText: { type: "string" },
        },
        required: ["hint", "lessonText"],
      },
    },
  ];
}

interface ToolResultPayload {
  resultText: string;
  isError?: boolean;
  proposal?: { fix: ProposedFix; lesson: string };
}

async function runTool(
  call: Anthropic.Messages.ToolUseBlock,
  ctx: { weekStart: string; customer: string },
): Promise<ToolResultPayload> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  try {
    switch (call.name) {
      case "get_current_punches":
        return { resultText: JSON.stringify(await loadCurrentPunches(ctx)) };
      case "get_driver_roster":
        return { resultText: JSON.stringify(await loadRoster(ctx)) };
      case "get_existing_lessons": {
        const lessons = await loadLessonsForPrompt(ctx.customer);
        return { resultText: JSON.stringify({ lessons }) };
      }
      case "get_last_upload_file_info":
        return { resultText: JSON.stringify(await loadLastUploadInfo(ctx)) };
      case "propose_add_punches": {
        const punches = (input.punches as unknown[]) ?? [];
        const lessonText = String(input.lessonText ?? "").trim();
        if (!Array.isArray(punches) || punches.length === 0 || !lessonText) {
          return { resultText: "punches and lessonText are required", isError: true };
        }
        return {
          resultText: "Proposal recorded. Stop after this call.",
          proposal: {
            fix: {
              kind: "addPunches",
              punches: punches.map((p) => normalizeAddPunch(p as Record<string, unknown>)),
            },
            lesson: lessonText,
          },
        };
      }
      case "propose_edit_punch": {
        const punchId = Number(input.punchId);
        const lessonText = String(input.lessonText ?? "").trim();
        if (!Number.isInteger(punchId) || !lessonText) {
          return { resultText: "punchId and lessonText are required", isError: true };
        }
        return {
          resultText: "Proposal recorded.",
          proposal: {
            fix: {
              kind: "editPunch",
              punchId,
              clockIn: typeof input.clockIn === "string" ? input.clockIn : undefined,
              clockOut: typeof input.clockOut === "string" ? input.clockOut : undefined,
              date: typeof input.date === "string" ? input.date : undefined,
              hours: typeof input.hours === "number" ? input.hours : undefined,
            },
            lesson: lessonText,
          },
        };
      }
      case "propose_delete_punch": {
        const punchId = Number(input.punchId);
        const reason = String(input.reason ?? "").trim();
        const lessonText = String(input.lessonText ?? "").trim();
        if (!Number.isInteger(punchId) || !reason || !lessonText) {
          return { resultText: "punchId, reason, lessonText required", isError: true };
        }
        return {
          resultText: "Proposal recorded.",
          proposal: {
            fix: { kind: "deletePunch", punchId, reason },
            lesson: lessonText,
          },
        };
      }
      case "propose_add_driver_alias": {
        const nameOnDoc = String(input.nameOnDoc ?? "").trim();
        const kfiId = String(input.kfiId ?? "").trim();
        const lessonText = String(input.lessonText ?? "").trim();
        if (!nameOnDoc || !kfiId || !lessonText) {
          return { resultText: "nameOnDoc, kfiId, lessonText required", isError: true };
        }
        return {
          resultText: "Proposal recorded.",
          proposal: {
            fix: { kind: "addDriverAlias", nameOnDoc, kfiId },
            lesson: lessonText,
          },
        };
      }
      case "propose_re_extract_with_hint": {
        const hint = String(input.hint ?? "").trim();
        const lessonText = String(input.lessonText ?? "").trim();
        const sampleId =
          typeof input.sampleId === "number" && Number.isInteger(input.sampleId)
            ? input.sampleId
            : undefined;
        if (!hint || !lessonText) {
          return { resultText: "hint and lessonText required", isError: true };
        }
        return {
          resultText: "Proposal recorded.",
          proposal: {
            fix: { kind: "reExtractWithHint", hint, sampleId },
            lesson: lessonText,
          },
        };
      }
      default:
        return { resultText: `Unknown tool: ${call.name}`, isError: true };
    }
  } catch (err) {
    logger.warn({ err, tool: call.name }, "chat tool failed");
    return {
      resultText: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

function normalizeAddPunch(p: Record<string, unknown>) {
  return {
    kfiId: String(p.kfiId ?? "").trim(),
    date: String(p.date ?? "").trim(),
    clockIn: String(p.clockIn ?? "").trim(),
    clockOut: String(p.clockOut ?? "").trim(),
    payType:
      p.payType === "Reg" || p.payType === "OT"
        ? (p.payType as "Reg" | "OT")
        : null,
    notes: typeof p.notes === "string" ? p.notes : undefined,
  };
}

async function loadCurrentPunches(ctx: {
  weekStart: string;
  customer: string;
}) {
  const rows = await db
    .select({
      id: schema.punchesTable.id,
      kfiId: schema.punchesTable.kfiId,
      date: schema.punchesTable.date,
      clockIn: schema.punchesTable.clockIn,
      clockOut: schema.punchesTable.clockOut,
      hours: schema.punchesTable.hours,
      source: schema.punchesTable.source,
      payType: schema.punchesTable.payType,
      isManual: schema.punchesTable.isManual,
      customer: schema.punchesTable.customer,
    })
    .from(schema.punchesTable)
    .where(
      and(
        eq(schema.punchesTable.weekStart, ctx.weekStart),
        sql`lower(coalesce(${schema.punchesTable.customer}, '')) = lower(${ctx.customer})`,
      ),
    )
    .orderBy(
      asc(schema.punchesTable.kfiId),
      asc(schema.punchesTable.date),
      asc(schema.punchesTable.clockIn),
    );
  return { punches: rows };
}

async function loadRoster(ctx: { customer: string }) {
  // Use the same shape the AI extractor sees, scoped to this customer's
  // recent driver pool. Kept simple here — full pool building lives in
  // weeks.ts and isn't needed for the chat's tool calls.
  const drivers = await db
    .select({
      kfiId: schema.driversTable.kfiId,
      name: schema.driversTable.name,
    })
    .from(schema.driversTable)
    .orderBy(asc(schema.driversTable.name));
  const aliases = await db
    .select({
      nameOnDoc: schema.customerNameAliasesTable.nameOnDoc,
      kfiId: schema.customerNameAliasesTable.kfiId,
    })
    .from(schema.customerNameAliasesTable)
    .where(
      sql`lower(${schema.customerNameAliasesTable.customer}) = lower(${ctx.customer})`,
    );
  const aliasMap = new Map<string, string[]>();
  for (const a of aliases) {
    const existing = aliasMap.get(a.kfiId) ?? [];
    existing.push(a.nameOnDoc);
    aliasMap.set(a.kfiId, existing);
  }
  return {
    drivers: drivers.map((d) => ({
      kfiId: d.kfiId,
      name: d.name,
      aliases: aliasMap.get(d.kfiId) ?? [],
    })),
  };
}

async function loadLastUploadInfo(ctx: { weekStart: string; customer: string }) {
  const row = await db
    .select({
      id: schema.aiExtractSamplesTable.id,
      fileName: schema.aiExtractSamplesTable.fileName,
      mimeType: schema.aiExtractSamplesTable.mimeType,
      sizeBytes: schema.aiExtractSamplesTable.sizeBytes,
      uploadedAt: schema.aiExtractSamplesTable.uploadedAt,
    })
    .from(schema.aiExtractSamplesTable)
    .where(
      and(
        eq(schema.aiExtractSamplesTable.weekStart, ctx.weekStart),
        sql`lower(${schema.aiExtractSamplesTable.customer}) = lower(${ctx.customer})`,
      ),
    )
    .orderBy(desc(schema.aiExtractSamplesTable.uploadedAt))
    .limit(1);
  if (row.length === 0) return { lastUpload: null };
  const r = row[0];
  return {
    lastUpload: {
      sampleId: r.id,
      fileName: r.fileName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      uploadedAt: new Date(r.uploadedAt).toISOString(),
    },
  };
}

// Re-exported so unit tests can directly drive a deterministic tool
// loop without an Anthropic API key.
export const _internals = {
  buildToolDefs,
  buildSystemPrompt,
  runTool,
  CHAT_MODEL,
};

