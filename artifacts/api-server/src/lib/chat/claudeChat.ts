import { and, eq, sql, desc, asc } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import { db, schema } from "../db.js";
import { logger } from "../logger.js";
import {
  getClaudeClient,
  DEFAULT_CLAUDE_MODEL,
} from "../parsers/claude.js";
import { getModelClient } from "../parsers/modelClient.js";
import { loadLessonsForPrompt } from "./lessonsStore.js";
import type { ProposedFix, FileEvidence } from "@workspace/db/schema";
import type {
  StashedExtractedPunch,
  PendingNamedRow,
} from "@workspace/db/schema";

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

/**
 * Task #419: per-chat-turn read budget for the file-read tools so a
 * chat can't burn unbounded Claude input tokens replaying a 5 MB
 * xlsx. Counted across `read_upload_file_rows` and
 * `read_upload_file_raw` combined. Hitting either cap returns a
 * clean error to Claude (it can still ask the dispatcher) instead of
 * throwing the whole turn.
 */
const CHAT_FILE_READ_MAX_CALLS = 8;
const CHAT_FILE_READ_MAX_BYTES = 200_000;
const CHAT_FILE_READ_DEFAULT_MAX_BYTES = 50_000;

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
  /**
   * Task #420 / #424: evidence pulled from the uploaded file during
   * this turn — rows the assistant read via `read_upload_file_rows`
   * AND raw-text slices it read via `read_upload_file_raw` — surfaced
   * to the dispatcher as a collapsible evidence block beside the
   * proposed fix. `null` when no file read happened (or the file was
   * unavailable / over-budget).
   */
  fileEvidence: FileEvidence | null;
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
 * Task #419: per-turn cache + read budget for the file-read tools.
 * Created once at the top of `runChatTurn` and threaded through every
 * `runTool` invocation so the sample row + raw text are loaded at
 * most once per turn even if Claude calls both read tools.
 */
interface ChatToolCtx {
  weekStart: string;
  customer: string;
  cache: ChatToolCache;
  /**
   * Task #420: accumulates de-duplicated rows returned by
   * `read_upload_file_rows` across all calls within a single user
   * turn. Surfaced to the dispatcher beside the proposed fix.
   */
  evidence: EvidenceAccumulator;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/**
 * Task #420: per-turn evidence collector. Each
 * `read_upload_file_rows` call merges its resolved + pending rows
 * here, keyed for de-duplication so a runaway Claude that calls the
 * same filter five times only ever appears as a single row to the
 * dispatcher.
 */
type RawSnippetEntry = NonNullable<FileEvidence["rawSnippets"]>[number];

/**
 * Task #424: cap the persisted raw-snippet text per read. Claude can
 * read up to 50 KB of raw file text per call, but the dispatcher only
 * needs the first ~500 chars to sanity-check what the assistant
 * grounded its proposal on — so we trim before stashing on the
 * assistant message row to keep the JSONB column slim.
 */
const RAW_SNIPPET_PERSIST_CHARS = 500;

class EvidenceAccumulator {
  private sampleId: number | null = null;
  private fileName = "";
  private resolved = new Map<string, FileEvidence["resolvedRows"][number]>();
  private pending = new Map<string, FileEvidence["pendingRows"][number]>();
  private rawSnippets = new Map<string, RawSnippetEntry>();

  record(
    sampleId: number,
    fileName: string,
    resolvedRows: FileEvidence["resolvedRows"],
    pendingRows: FileEvidence["pendingRows"],
  ): void {
    this.sampleId = sampleId;
    this.fileName = fileName;
    for (const r of resolvedRows) {
      const key = `${r.kfiId}|${r.date}|${r.clockIn}|${r.clockOut}`;
      if (!this.resolved.has(key)) this.resolved.set(key, r);
    }
    for (const r of pendingRows) {
      const key = `${r.driverNameOnDoc}|${r.date}|${r.timeIn ?? ""}|${r.timeOut ?? ""}`;
      if (!this.pending.has(key)) this.pending.set(key, r);
    }
  }

  /**
   * Task #424: stash a `read_upload_file_raw` slice for the dispatcher.
   * Dedupes by (sampleId, persisted-snippet) so repeated raw reads
   * with the same prefix collapse to a single entry.
   */
  recordRaw(
    sampleId: number,
    fileName: string,
    totalChars: number,
    returnedChars: number,
    truncated: boolean,
    text: string,
  ): void {
    this.sampleId = sampleId;
    this.fileName = fileName;
    const snippet =
      text.length > RAW_SNIPPET_PERSIST_CHARS
        ? text.slice(0, RAW_SNIPPET_PERSIST_CHARS)
        : text;
    const key = `${sampleId}|${snippet}`;
    if (this.rawSnippets.has(key)) return;
    this.rawSnippets.set(key, {
      sampleId,
      fileName,
      totalChars,
      returnedChars,
      truncated: truncated || text.length > RAW_SNIPPET_PERSIST_CHARS,
      snippet,
    });
  }

  build(): FileEvidence | null {
    if (this.sampleId === null) return null;
    if (
      this.resolved.size === 0 &&
      this.pending.size === 0 &&
      this.rawSnippets.size === 0
    )
      return null;
    const out: FileEvidence = {
      sampleId: this.sampleId,
      fileName: this.fileName,
      resolvedRows: [...this.resolved.values()],
      pendingRows: [...this.pending.values()],
    };
    if (this.rawSnippets.size > 0) {
      out.rawSnippets = [...this.rawSnippets.values()];
    }
    return out;
  }
}

interface UploadSampleCache {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Date;
  fileBytes: Buffer;
  extractedRows: StashedExtractedPunch[] | null;
  pendingNamedRows: PendingNamedRow[] | null;
}

class ChatToolCache {
  private samplePromise: Promise<UploadSampleCache | null> | null = null;
  private rawTextPromise: Promise<string> | null = null;
  callsUsed = 0;
  bytesUsed = 0;

  /**
   * Test seam — unit tests pre-populate the sample so they don't
   * need a live DB. Throws if a sample was already loaded.
   */
  preloadSample(sample: UploadSampleCache | null): void {
    if (this.samplePromise) {
      throw new Error("preloadSample called after sample was already loaded");
    }
    this.samplePromise = Promise.resolve(sample);
  }

  async getSample(ctx: { weekStart: string; customer: string }) {
    if (!this.samplePromise) this.samplePromise = loadUploadSample(ctx);
    return this.samplePromise;
  }

  async getRawText(ctx: { weekStart: string; customer: string }) {
    if (!this.rawTextPromise) this.rawTextPromise = loadRawText(this, ctx);
    return this.rawTextPromise;
  }

  /**
   * Reserve one call slot before any DB or file work. Returns `null`
   * when the call is allowed, or an error message when the per-turn
   * call budget has been exhausted. Always called at tool entry — so
   * no-sample / parse-error / over-budget paths all count, preventing
   * a runaway loop from doing expensive work after the budget is
   * already blown.
   */
  tryConsumeCall(): string | null {
    if (this.callsUsed >= CHAT_FILE_READ_MAX_CALLS) {
      return `File-read budget exhausted for this turn (max ${CHAT_FILE_READ_MAX_CALLS} reads). Ask the dispatcher for the specific punch times instead.`;
    }
    this.callsUsed += 1;
    return null;
  }

  /**
   * Charge a successful read against the byte budget. Called at the
   * end of a tool with the size of the JSON payload being returned to
   * Claude. Returns an error message if this read would push us over
   * the per-turn byte cap.
   */
  tryConsumeBytes(byteCount: number): string | null {
    if (this.bytesUsed + byteCount > CHAT_FILE_READ_MAX_BYTES) {
      return `File-read byte budget exhausted for this turn (max ${CHAT_FILE_READ_MAX_BYTES.toLocaleString()} bytes returned). Narrow the filter (driverNameContains/date/kfiId) or ask the dispatcher.`;
    }
    this.bytesUsed += byteCount;
    return null;
  }
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
  // Task #419: per-turn cache so file-read tools load the sample row
  // (and PDF/xlsx text serialization) at most once per turn.
  const cache = new ChatToolCache();
  const evidence = new EvidenceAccumulator();
  const toolCtx: ChatToolCtx = {
    weekStart: input.weekStart,
    customer: input.customer,
    cache,
    evidence,
  };

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
      const handled = await runTool(tu, toolCtx);
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
    fileEvidence: evidence.build(),
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
    `   When the dispatcher says a punch is missing or wrong, call \`read_upload_file_rows\` FIRST (filtered by driver name and/or date) to see what the uploaded file actually contained — this works for BOTH AI-extracted uploads and uploads imported by the built-in parser, since every confirmed upload keeps the original file stashed for 90 days. If the rows view shows nothing for the driver/date in question, call \`read_upload_file_raw\` to inspect the raw file text — the parser may have dropped a row that's actually present. Only ask the dispatcher for clock-in / clock-out times after both file reads come up empty.`,
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
        "Return metadata about the most recent customer-file upload for this customer-week (filename, mimeType, size, sampleId, uploadedAt, whether stashed rows + raw bytes are available for reading).",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "read_upload_file_rows",
      description:
        "Read the rows the AI extractor saw in the most recent uploaded customer file for this customer-week. Optional filters narrow the response — prefer narrow filters to keep the response small. Returns BOTH the rows that resolved to a kfiId AND the rows that were still pending (driver name on doc not yet aliased). Use this FIRST when the dispatcher says a punch is missing or wrong — the file itself is the source of truth, not the dispatcher's memory of it.",
      input_schema: {
        type: "object",
        properties: {
          driverNameContains: {
            type: "string",
            description:
              "Case-insensitive substring match against the driver roster name (resolved rows) and the name-on-doc (pending rows).",
          },
          date: {
            type: "string",
            description: "YYYY-MM-DD date filter — only rows on that date.",
          },
          kfiId: {
            type: "string",
            description: "Exact kfiId filter on resolved rows.",
          },
        },
      },
    },
    {
      name: "read_upload_file_raw",
      description:
        "Read the original uploaded file's raw text (xlsx → CSV, text-bearing pdf → extracted text, scanned-image pdf / image upload → AI OCR transcription). Use this as a fallback when `read_upload_file_rows` is empty or you suspect the extractor dropped a row that's actually present in the file. Bounded by a per-turn budget — narrow the response with `maxBytes` (default 50_000) when possible.",
      input_schema: {
        type: "object",
        properties: {
          maxBytes: {
            type: "integer",
            description: `Optional cap on returned bytes (default ${CHAT_FILE_READ_DEFAULT_MAX_BYTES}, hard max ${CHAT_FILE_READ_MAX_BYTES}). The returned text is truncated to this many characters.`,
          },
        },
      },
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
  ctx: ChatToolCtx,
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
      case "read_upload_file_rows":
        return await runReadUploadFileRows(input, ctx);
      case "read_upload_file_raw":
        return await runReadUploadFileRaw(input, ctx);
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

async function runReadUploadFileRows(
  input: Record<string, unknown>,
  ctx: ChatToolCtx,
): Promise<ToolResultPayload> {
  // Reserve a call slot BEFORE touching the DB so an over-budget
  // loop can't keep paying for sample lookups (and the no-sample
  // path below still counts against the call cap).
  const callTripped = ctx.cache.tryConsumeCall();
  if (callTripped) return { resultText: callTripped, isError: true };
  const sample = await ctx.cache.getSample(ctx);
  if (!sample) {
    return {
      resultText: JSON.stringify({
        lastUpload: null,
        message:
          "No stashed file is available for this customer-week. The file may have been uploaded before 90-day stash retention was enabled, may have expired, or was never uploaded at all. Ask the dispatcher to re-upload it (or to share the relevant punch times directly).",
      }),
    };
  }
  const driverNameContains = typeof input.driverNameContains === "string"
    ? input.driverNameContains.trim().toLowerCase()
    : "";
  const date = typeof input.date === "string" ? input.date.trim() : "";
  const kfiId = typeof input.kfiId === "string" ? input.kfiId.trim() : "";

  // Build a kfiId → driver-name lookup for the resolved rows so the
  // driverNameContains filter can match against the roster name.
  // Only hit the DB when the filter is actually set — otherwise we
  // don't need the names at all, and unit tests don't need a DB.
  let nameByKfiId = new Map<string, string>();
  if (driverNameContains) {
    const rosterRows = await db
      .select({
        kfiId: schema.driversTable.kfiId,
        name: schema.driversTable.name,
      })
      .from(schema.driversTable);
    nameByKfiId = new Map(rosterRows.map((r) => [r.kfiId, r.name]));
  }

  const allResolved = sample.extractedRows ?? [];
  const resolved = allResolved
    .filter((r) => (!date || r.date === date))
    .filter((r) => (!kfiId || r.kfiId === kfiId))
    .filter((r) => {
      if (!driverNameContains) return true;
      const n = (nameByKfiId.get(r.kfiId) ?? "").toLowerCase();
      return n.includes(driverNameContains);
    })
    .map((r) => ({
      kfiId: r.kfiId,
      driverName: nameByKfiId.get(r.kfiId) ?? null,
      date: r.date,
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      hours: r.hours,
      payType: r.payType,
    }));

  const allPending = sample.pendingNamedRows ?? [];
  const pending = allPending
    .filter((r) => (!date || r.date === date))
    .filter((r) => {
      if (!driverNameContains) return true;
      return r.driverNameOnDoc.toLowerCase().includes(driverNameContains);
    })
    .map((r) => ({
      driverNameOnDoc: r.driverNameOnDoc,
      badgeOrId: r.badgeOrId,
      date: r.date,
      timeIn: r.timeIn,
      timeOut: r.timeOut,
      hours: r.hours,
    }));

  const payload = {
    sampleId: sample.id,
    fileName: sample.fileName,
    resolvedRowsTotal: allResolved.length,
    pendingRowsTotal: allPending.length,
    resolvedRowsReturned: resolved.length,
    pendingRowsReturned: pending.length,
    filterUsed: { driverNameContains: driverNameContains || null, date: date || null, kfiId: kfiId || null },
    resolvedRows: resolved,
    pendingRows: pending,
  };
  const body = JSON.stringify(payload);
  const tripped = ctx.cache.tryConsumeBytes(Buffer.byteLength(body, "utf8"));
  if (tripped) {
    return { resultText: tripped, isError: true };
  }
  // Task #420: stash the rows we just returned to Claude so the
  // dispatcher can see them on the proposed-fix card. Recorded only
  // after the byte-budget check passes — over-budget reads are not
  // surfaced to Claude and so shouldn't be surfaced to the dispatcher
  // either.
  ctx.evidence.record(sample.id, sample.fileName, resolved, pending);
  return { resultText: body };
}

async function runReadUploadFileRaw(
  input: Record<string, unknown>,
  ctx: ChatToolCtx,
): Promise<ToolResultPayload> {
  // Reserve a call slot BEFORE doing any DB lookup or xlsx/pdf
  // parsing — a malicious / extremely large file could otherwise be
  // re-parsed on every loop iteration even after the budget is blown.
  const callTripped = ctx.cache.tryConsumeCall();
  if (callTripped) return { resultText: callTripped, isError: true };
  const sample = await ctx.cache.getSample(ctx);
  if (!sample) {
    return {
      resultText: JSON.stringify({
        lastUpload: null,
        message:
          "No stashed file is available for this customer-week. Ask the dispatcher to share the relevant punch times directly.",
      }),
    };
  }
  const rawMax = Number(input.maxBytes);
  const wanted =
    Number.isInteger(rawMax) && rawMax > 0
      ? Math.min(rawMax, CHAT_FILE_READ_MAX_BYTES)
      : CHAT_FILE_READ_DEFAULT_MAX_BYTES;

  let text: string;
  try {
    text = await ctx.cache.getRawText(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      resultText: JSON.stringify({
        sampleId: sample.id,
        fileName: sample.fileName,
        mimeType: sample.mimeType,
        text: null,
        message: `Could not read file as text: ${msg}. The file may be a scanned image — ask the dispatcher for specific punch times.`,
      }),
    };
  }

  const truncated = text.length > wanted;
  const slice = truncated ? text.slice(0, wanted) : text;
  const payload = {
    sampleId: sample.id,
    fileName: sample.fileName,
    mimeType: sample.mimeType,
    totalChars: text.length,
    returnedChars: slice.length,
    truncated,
    text: slice,
  };
  const body = JSON.stringify(payload);
  const tripped = ctx.cache.tryConsumeBytes(Buffer.byteLength(body, "utf8"));
  if (tripped) {
    return { resultText: tripped, isError: true };
  }
  // Task #424: stash the slice we returned to Claude so the dispatcher
  // can see it on the proposed-fix card. Recorded only after the
  // byte-budget check passes — over-budget reads aren't surfaced to
  // Claude and so shouldn't be surfaced to the dispatcher either.
  ctx.evidence.recordRaw(
    sample.id,
    sample.fileName,
    text.length,
    slice.length,
    truncated,
    slice,
  );
  return { resultText: body };
}

async function loadUploadSample(ctx: {
  weekStart: string;
  customer: string;
}): Promise<UploadSampleCache | null> {
  const rows = await db
    .select({
      id: schema.aiExtractSamplesTable.id,
      fileName: schema.aiExtractSamplesTable.fileName,
      mimeType: schema.aiExtractSamplesTable.mimeType,
      sizeBytes: schema.aiExtractSamplesTable.sizeBytes,
      uploadedAt: schema.aiExtractSamplesTable.uploadedAt,
      fileBytes: schema.aiExtractSamplesTable.fileBytes,
      extractedRows: schema.aiExtractSamplesTable.extractedRows,
      pendingNamedRows: schema.aiExtractSamplesTable.pendingNamedRows,
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
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    fileName: r.fileName,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    uploadedAt: r.uploadedAt as Date,
    fileBytes: Buffer.isBuffer(r.fileBytes)
      ? r.fileBytes
      : Buffer.from(r.fileBytes as Uint8Array),
    extractedRows: r.extractedRows ?? null,
    pendingNamedRows: r.pendingNamedRows ?? null,
  };
}

async function loadRawText(
  cache: ChatToolCache,
  ctx: { weekStart: string; customer: string },
): Promise<string> {
  const sample = await cache.getSample(ctx);
  if (!sample) return "";
  const name = sample.fileName.toLowerCase();
  const mime = (sample.mimeType ?? "").toLowerCase();
  // Treat as xlsx if the extension or mimetype says so.
  const isXlsx =
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    mime.includes("spreadsheetml") ||
    mime === "application/vnd.ms-excel";
  const isImage =
    mime.startsWith("image/") ||
    /\.(jpg|jpeg|png|webp|gif|heic|heif)$/.test(name);
  // Task #421: image uploads have no extractable text — route them
  // through the AI extractor's OCR fallback (same model client the
  // bulk extractor uses) so the chat can ground itself on photos /
  // phone-snaps of timecards, not just xlsx + text-bearing PDFs.
  if (isImage) {
    return await ocrToText(sample);
  }
  // Bound the parsing work itself, not just the returned slice. We
  // stop sheet/page iteration once we've gathered ~2x the per-turn
  // byte cap so a 200-sheet xlsx or 500-page pdf can't pin the
  // event loop. The caller still slices to its own maxBytes.
  const PARSE_CHAR_CAP = CHAT_FILE_READ_MAX_BYTES * 2;
  if (isXlsx) {
    const wb = XLSX.read(sample.fileBytes, { type: "buffer" });
    const parts: string[] = [];
    let charsSoFar = 0;
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (csv.trim().length === 0) continue;
      parts.push(`# Sheet: ${sheetName}\n${csv}`);
      charsSoFar += csv.length;
      if (charsSoFar >= PARSE_CHAR_CAP) break;
    }
    return parts.join("\n\n");
  }
  const isPdf = name.endsWith(".pdf") || mime === "application/pdf";
  if (isPdf) {
    // Lazy-load pdfjs so the chat path doesn't pay the parse cost
    // until a Claude tool call actually asks for raw text.
    const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(sample.fileBytes);
    const doc = await mod.getDocument({
      data,
    } as Parameters<typeof mod.getDocument>[0]).promise;
    const pages: string[] = [];
    let charsSoFar = 0;
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const items: string[] = [];
        for (const it of content.items) {
          if (typeof (it as { str?: unknown }).str === "string") {
            items.push((it as { str: string }).str);
          }
        }
        const pageText = items.join(" ");
        pages.push(pageText);
        charsSoFar += pageText.length;
        if (charsSoFar >= PARSE_CHAR_CAP) break;
        if (p < doc.numPages) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      await doc.destroy();
    }
    const joined = pages.join("\n\n").trim();
    if (joined.length < 50) {
      // Task #421: scanned-image PDF — pdfjs found no text. Reuse the
      // AI extractor's OCR fallback (send the PDF as an inline-data
      // attachment to the model) so the chat can still ground itself
      // in the file.
      return await ocrToText(sample);
    }
    return joined;
  }
  throw new Error(
    `unsupported file type for raw read (${sample.mimeType || sample.fileName}); only xlsx/xls/pdf/image are supported`,
  );
}

/**
 * Task #421: OCR fallback for image uploads and scanned-image PDFs.
 * Mirrors the bulk AI extractor's image / scanned-PDF lane in
 * `aiExtract.ts` — we send the file as a single inline-data
 * attachment and ask the model to transcribe text verbatim. The
 * returned text is fed through the same per-turn byte budget as the
 * xlsx / text-PDF paths.
 *
 * Override via `_internals.setOcrOverride` in tests so the unit
 * suite doesn't need an API key.
 */
let _ocrOverride: ((s: UploadSampleCache) => Promise<string>) | null = null;

function setOcrOverride(
  fn: ((s: UploadSampleCache) => Promise<string>) | null,
): void {
  _ocrOverride = fn;
}

async function ocrToText(sample: UploadSampleCache): Promise<string> {
  if (_ocrOverride) return _ocrOverride(sample);
  const name = sample.fileName.toLowerCase();
  const mime = (sample.mimeType ?? "").toLowerCase();
  const isPdf = name.endsWith(".pdf") || mime === "application/pdf";
  // Image media types Claude accepts; HEIC isn't in the allow-list, so
  // fall through to JPEG (the bulk extractor transcodes HEIC → JPEG
  // before reaching that path, but we have no transcoder here — best
  // effort, the model will return an error string which the caller
  // surfaces verbatim).
  const allowedImage = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
  const inlineMime = isPdf
    ? "application/pdf"
    : allowedImage.has(mime)
      ? mime
      : "image/jpeg";
  const client = await getModelClient();
  const { text } = await client.generate({
    parts: [
      {
        kind: "text",
        text:
          "Transcribe every piece of text visible in the attached " +
          (isPdf ? "scanned PDF" : "image") +
          " verbatim. Preserve row/column structure as plain text — " +
          "use spaces or tabs between cells, one logical row per line. " +
          "Do not summarise, do not add commentary, do not wrap in markdown. " +
          "If the document is unreadable, reply with the single line " +
          "`(no readable text)`.",
      },
      {
        kind: "inlineData",
        mimeType: inlineMime,
        data: sample.fileBytes.toString("base64"),
      },
    ],
    maxOutputTokens: 4096,
    timeoutMs: 90_000,
  });
  return text.trim();
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
  const lower = (r.fileName ?? "").toLowerCase();
  const mime = (r.mimeType ?? "").toLowerCase();
  const isXlsx =
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    mime.includes("spreadsheetml") ||
    mime === "application/vnd.ms-excel";
  const isPdf = lower.endsWith(".pdf") || mime === "application/pdf";
  const isImage =
    mime.startsWith("image/") ||
    /\.(jpg|jpeg|png|webp|gif|heic|heif)$/.test(lower);
  return {
    lastUpload: {
      sampleId: r.id,
      fileName: r.fileName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      uploadedAt: new Date(r.uploadedAt).toISOString(),
      // Task #419 + #421: tell Claude which read tools will work for
      // this sample. xlsx + text-bearing PDFs come back as raw text;
      // image uploads and scanned-image PDFs come back via the AI OCR
      // fallback (same model client the bulk extractor uses).
      rawTextReadable: isXlsx || isPdf || isImage,
      stashedRowsAvailable: true,
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
  ChatToolCache,
  EvidenceAccumulator,
  CHAT_FILE_READ_MAX_CALLS,
  CHAT_FILE_READ_MAX_BYTES,
  setOcrOverride,
};
export type { UploadSampleCache };

