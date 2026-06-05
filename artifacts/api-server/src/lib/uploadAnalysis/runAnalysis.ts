import type Anthropic from "@anthropic-ai/sdk";
import { and, count, eq, sql } from "drizzle-orm";
import { db, schema } from "../db.js";
import { logger } from "../logger.js";
import { getClaudeClient, DEFAULT_CLAUDE_ANALYSIS_MODEL } from "../parsers/claude.js";
import { _internals as chatInternals } from "../chat/claudeChat.js";
import { costUsd } from "../parsers/pricing.js";
import {
  PROMPT_VERSION,
  SUBMIT_ANALYSIS_TOOL_NAME,
  buildAnalysisSystemPrompt,
  submitAnalysisToolDef,
  verdictPayloadSchema,
} from "./contract.js";

export type Lane = "ai" | "parser";

export interface RunAnalysisInput {
  sampleId: number;
  customer: string;
  weekStart: string;
  fileName: string;
  lane: Lane;
  triggeredBy?: number | null;
}

export interface RunAnalysisResult {
  ok: boolean;
  verdictId?: number;
  verdict?: string;
  err?: string;
  validationError?: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
}

const MAX_TURNS = 8;
const MAX_OUTPUT_TOKENS = 2048;
const PER_CALL_TIMEOUT_MS = 90_000;

// The upload reviewer runs on the most-capable model by default (Opus),
// since a sharp verdict is the whole point of the feature and it runs at
// most once per confirmed upload. Overridable via `CLAUDE_ANALYSIS_MODEL`
// so prod can switch models without a code change — mirrors how the chat
// (`CLAUDE_CHAT_MODEL`) and extractor (`CLAUDE_EXTRACT_MODEL`) each read
// their own override.
const ANALYSIS_MODEL =
  process.env.CLAUDE_ANALYSIS_MODEL ?? DEFAULT_CLAUDE_ANALYSIS_MODEL;

type AnthropicLike = Pick<Anthropic, "messages">;

let clientFactory: () => AnthropicLike = () => getClaudeClient();

/** Test seam — replace the Anthropic client factory. */
export function _setClientFactoryForTests(f: () => AnthropicLike): void {
  clientFactory = f;
}

/** Test seam — restore the real client factory. */
export function _resetClientFactoryForTests(): void {
  clientFactory = () => getClaudeClient();
}

async function isFirstUploadForCustomer(
  customer: string,
  thisSampleId: number,
): Promise<boolean> {
  const rows = await db
    .select({ c: count() })
    .from(schema.aiExtractSamplesTable)
    .where(
      and(
        sql`lower(${schema.aiExtractSamplesTable.customer}) = lower(${customer})`,
        sql`${schema.aiExtractSamplesTable.confirmedAt} IS NOT NULL`,
        sql`${schema.aiExtractSamplesTable.id} < ${thisSampleId}`,
      ),
    );
  return Number(rows[0]?.c ?? 0) === 0;
}

async function loadSampleForCache(sampleId: number) {
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
      droppedRows: schema.aiExtractSamplesTable.droppedRows,
    })
    .from(schema.aiExtractSamplesTable)
    .where(eq(schema.aiExtractSamplesTable.id, sampleId))
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
    droppedRows: r.droppedRows ?? null,
  };
}

interface PersistArgs extends RunAnalysisInput {
  verdict: string;
  summary: string;
  findings: unknown[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  toolCalls: number;
  errMsg: string | null;
}

async function persistVerdict(a: PersistArgs): Promise<number> {
  // One verdict row per sample — re-runs overwrite. The unique index on
  // sample_id is what makes the dashboard's "latest confirmed sample wins"
  // selection deterministic even when analyses finish out of order.
  const values = {
    sampleId: a.sampleId,
    customer: a.customer,
    weekStart: a.weekStart,
    fileName: a.fileName,
    lane: a.lane,
    verdict: a.verdict,
    summary: a.summary,
    findings: a.findings,
    promptVersion: PROMPT_VERSION,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    costUsd: costUsd(ANALYSIS_MODEL, a.inputTokens, a.outputTokens),
    durationMs: a.durationMs,
    toolCalls: a.toolCalls,
    errMsg: a.errMsg,
    triggeredBy: a.triggeredBy ?? null,
  };
  const inserted = await db
    .insert(schema.uploadAnalysisVerdictsTable)
    .values(values)
    .onConflictDoUpdate({
      target: schema.uploadAnalysisVerdictsTable.sampleId,
      set: {
        customer: values.customer,
        weekStart: values.weekStart,
        fileName: values.fileName,
        lane: values.lane,
        verdict: values.verdict,
        summary: values.summary,
        findings: values.findings,
        promptVersion: values.promptVersion,
        inputTokens: values.inputTokens,
        outputTokens: values.outputTokens,
        costUsd: values.costUsd,
        durationMs: values.durationMs,
        toolCalls: values.toolCalls,
        errMsg: values.errMsg,
        triggeredBy: values.triggeredBy,
        createdAt: new Date(),
      },
    })
    .returning({ id: schema.uploadAnalysisVerdictsTable.id });
  return inserted[0]!.id;
}

export async function runUploadAnalysis(
  input: RunAnalysisInput,
): Promise<RunAnalysisResult> {
  const startedAt = Date.now();
  let totalIn = 0;
  let totalOut = 0;
  let toolCallCount = 0;
  let verdictRaw: unknown = null;
  let fatalError: string | undefined;

  try {
    const fullSample = await loadSampleForCache(input.sampleId);
    if (!fullSample) {
      const id = await persistVerdict({
        ...input,
        verdict: "error",
        summary: "",
        findings: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startedAt,
        toolCalls: 0,
        errMsg: "sample row disappeared before analysis could load it",
      });
      return {
        ok: false,
        verdictId: id,
        err: "sample missing",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const isFirst = await isFirstUploadForCustomer(
      input.customer,
      input.sampleId,
    );
    const system = buildAnalysisSystemPrompt({
      customer: input.customer,
      weekStart: input.weekStart,
      lane: input.lane,
      isFirstUpload: isFirst,
    });

    const cache = new chatInternals.ChatToolCache();
    cache.preloadSample(fullSample);
    const evidence = new chatInternals.EvidenceAccumulator();
    const ctx = {
      weekStart: input.weekStart,
      customer: input.customer,
      cache,
      evidence,
    };

    const tools: Anthropic.Messages.Tool[] = [
      {
        name: "read_upload_file_rows",
        description:
          "Read the rows the extractor saw in this uploaded file. Returns resolved + pending + dropped arrays.",
        input_schema: {
          type: "object",
          properties: {
            driverNameContains: { type: "string" },
            date: { type: "string" },
            kfiId: { type: "string" },
          },
        },
      },
      {
        name: "read_upload_file_raw",
        description:
          "Read the original uploaded file's raw text (xlsx -> CSV, text-bearing pdf -> extracted text, scanned/image -> AI OCR). Bounded per-turn.",
        input_schema: {
          type: "object",
          properties: { maxBytes: { type: "integer" } },
        },
      },
      submitAnalysisToolDef(),
    ];

    const messages: Anthropic.Messages.MessageParam[] = [
      {
        role: "user",
        content: `Analyze the just-confirmed upload for customer "${input.customer}", payroll week starting ${input.weekStart}, file "${input.fileName}" (${fullSample.mimeType}, ${fullSample.sizeBytes} bytes, lane=${input.lane}). Call read tools as needed, then submit your verdict via ${SUBMIT_ANALYSIS_TOOL_NAME}.`,
      },
    ];

    const client = clientFactory();
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const forceSubmit = turn === MAX_TURNS - 1;
      const response = await client.messages.create(
        {
          model: ANALYSIS_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools,
          messages,
          tool_choice: forceSubmit
            ? { type: "tool", name: SUBMIT_ANALYSIS_TOOL_NAME }
            : { type: "auto" },
        },
        { timeout: PER_CALL_TIMEOUT_MS },
      );
      totalIn += response.usage?.input_tokens ?? 0;
      totalOut += response.usage?.output_tokens ?? 0;

      const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") toolUses.push(block);
      }
      if (toolUses.length === 0) {
        fatalError = `model stopped without calling ${SUBMIT_ANALYSIS_TOOL_NAME} (stop_reason=${response.stop_reason})`;
        break;
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      let submitted = false;
      for (const tu of toolUses) {
        toolCallCount += 1;
        if (tu.name === SUBMIT_ANALYSIS_TOOL_NAME) {
          verdictRaw = tu.input;
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "verdict recorded",
          });
          submitted = true;
          continue;
        }
        const handled = await chatInternals.runTool(tu, ctx);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: handled.resultText,
          is_error: handled.isError ?? false,
        });
      }
      messages.push({ role: "user", content: toolResults });
      if (submitted) break;
    }
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;

  if (fatalError) {
    const id = await persistVerdict({
      ...input,
      verdict: "error",
      summary: "",
      findings: [],
      inputTokens: totalIn,
      outputTokens: totalOut,
      durationMs,
      toolCalls: toolCallCount,
      errMsg: fatalError,
    });
    return {
      ok: false,
      verdictId: id,
      err: fatalError,
      inputTokens: totalIn,
      outputTokens: totalOut,
      toolCalls: toolCallCount,
      durationMs,
    };
  }

  const parsed = verdictPayloadSchema.safeParse(verdictRaw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    const id = await persistVerdict({
      ...input,
      verdict: "error",
      summary: "",
      findings: [],
      inputTokens: totalIn,
      outputTokens: totalOut,
      durationMs,
      toolCalls: toolCallCount,
      errMsg: `verdict payload failed validation: ${msg}`,
    });
    return {
      ok: false,
      verdictId: id,
      validationError: msg,
      inputTokens: totalIn,
      outputTokens: totalOut,
      toolCalls: toolCallCount,
      durationMs,
    };
  }

  const v = parsed.data;
  const id = await persistVerdict({
    ...input,
    verdict: v.verdict,
    summary: v.summary,
    findings: v.findings,
    inputTokens: totalIn,
    outputTokens: totalOut,
    durationMs,
    toolCalls: toolCallCount,
    errMsg: null,
  });
  return {
    ok: true,
    verdictId: id,
    verdict: v.verdict,
    inputTokens: totalIn,
    outputTokens: totalOut,
    toolCalls: toolCallCount,
    durationMs,
  };
}

/**
 * Fire-and-forget wrapper. Swallows errors after logging them so an
 * analysis failure never blocks or unwinds the confirm response.
 * Gated by env: only fires when `UPLOAD_ANALYSIS_ENABLED === "1"`.
 */
export function scheduleUploadAnalysis(input: RunAnalysisInput): void {
  if (process.env.UPLOAD_ANALYSIS_ENABLED !== "1") return;
  void runUploadAnalysis(input).then(
    (r) => {
      logger.info(
        {
          sampleId: input.sampleId,
          customer: input.customer,
          weekStart: input.weekStart,
          lane: input.lane,
          verdict: r.verdict,
          ok: r.ok,
          verdictId: r.verdictId,
          err: r.err,
          validationError: r.validationError,
          durationMs: r.durationMs,
          toolCalls: r.toolCalls,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
        },
        "upload_analysis_done",
      );
    },
    (err) => {
      logger.error(
        {
          err,
          sampleId: input.sampleId,
          customer: input.customer,
          weekStart: input.weekStart,
        },
        "upload_analysis_unhandled",
      );
    },
  );
}
