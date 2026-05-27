/**
 * Task #444 — throwaway prototype runner for the per-upload analysis pass.
 *
 * NOT a route, NOT wired into any workflow or CI. Run locally against the
 * dev DB to validate verdict quality BEFORE Phase 1 starts. Outputs:
 *
 *   .local/prototype/upload-analysis-verdicts-<promptVersion>.json
 *   .local/prototype/grading-rubric-<promptVersion>.md
 *
 * Usage:
 *
 *   # list candidate samples (most recent confirmed) so you can pick:
 *   pnpm --filter @workspace/api-server prototype-upload-analysis list [--limit 30]
 *
 *   # run analysis for a hand-picked set:
 *   pnpm --filter @workspace/api-server prototype-upload-analysis run \
 *     --samples 123,124,125 --version v1.0
 *
 * DB safety: refuses to run unless DATABASE_URL host + db are on the same
 * dev allow-list `createE2EPool()` uses. The prod DB is rejected.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

// IMPORTANT: assert the DB allow-list BEFORE we import anything that
// opens a Pool. `../lib/db.js` constructs a Pool on import. The function
// itself is hoisted (function declaration), but its `const` allow-lists
// are not — so the assert lives below those consts, before any dynamic
// import.

const ALLOWED_HOSTS = new Set(["helium", "localhost", "127.0.0.1"]);
const ALLOWED_DB_NAMES = new Set(["heliumdb"]);

assertDevDatabaseOrExit();

const { db, schema } = await import("../lib/db.js");
const { and, desc, eq, sql, count } = await import("drizzle-orm");
const { getClaudeClient, DEFAULT_CLAUDE_MODEL } = await import(
  "../lib/parsers/claude.js"
);
const { _internals } = await import("../lib/chat/claudeChat.js");
const { IngestionBudget } = await import("../lib/parsers/ingestionBudget.js");
const {
  PROMPT_VERSION,
  SUBMIT_ANALYSIS_TOOL_NAME,
  buildAnalysisSystemPrompt,
  submitAnalysisToolDef,
  verdictPayloadSchema,
} = await import("../lib/uploadAnalysis/contract.js");
type Lane = "ai" | "parser";

function assertDevDatabaseOrExit(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set.");
    process.exit(2);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error("DATABASE_URL is not a valid URL.");
    process.exit(2);
  }
  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, "");
  if (!ALLOWED_HOSTS.has(host) || !ALLOWED_DB_NAMES.has(database)) {
    console.error(
      `Refusing to run prototype against DATABASE_URL host=${host} db=${database}. ` +
        `Allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}; allowed dbs: ${[...ALLOWED_DB_NAMES].join(", ")}.`,
    );
    process.exit(2);
  }
}

function parseArgs(argv: string[]): {
  cmd: "list" | "run" | "help";
  sampleIds: number[];
  version: string;
  limit: number;
} {
  const args = argv.slice(2);
  const cmd = (args[0] as "list" | "run" | "help" | undefined) ?? "help";
  let sampleIds: number[] = [];
  let version = PROMPT_VERSION;
  let limit = 30;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--samples") {
      sampleIds = (args[++i] ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } else if (a === "--version") {
      version = String(args[++i] ?? PROMPT_VERSION);
    } else if (a === "--limit") {
      limit = Number(args[++i] ?? 30);
    }
  }
  if (cmd !== "list" && cmd !== "run" && cmd !== "help") {
    return { cmd: "help", sampleIds, version, limit };
  }
  return { cmd, sampleIds, version, limit };
}

function printHelp(): void {
  console.log(
    [
      "Task #444 prototype runner for upload-analysis verdict quality.",
      "",
      "Commands:",
      "  list [--limit 30]                List recent confirmed samples (most recent first).",
      "  run --samples 1,2,3 [--version v1.0]",
      "                                   Run analysis on the given sample IDs and write",
      "                                   .local/prototype/upload-analysis-verdicts-<v>.json",
      "                                   .local/prototype/grading-rubric-<v>.md",
      "",
      `Current PROMPT_VERSION baked into contract.ts: ${PROMPT_VERSION}`,
    ].join("\n"),
  );
}

interface SampleRow {
  id: number;
  weekStart: string;
  customer: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: Date;
  confirmedAt: Date | null;
  pendingNamedRows: unknown;
  extractedRowsLen: number;
  pendingRowsLen: number;
  droppedRowsLen: number;
}

async function listRecentConfirmedSamples(limit: number): Promise<SampleRow[]> {
  // pendingNamedRows IS NOT NULL => AI lane (route stashes that field
  // only for the AI lane). NULL => parser/cache lane.
  const rows = await db
    .select({
      id: schema.aiExtractSamplesTable.id,
      weekStart: schema.aiExtractSamplesTable.weekStart,
      customer: schema.aiExtractSamplesTable.customer,
      fileName: schema.aiExtractSamplesTable.fileName,
      mimeType: schema.aiExtractSamplesTable.mimeType,
      sizeBytes: schema.aiExtractSamplesTable.sizeBytes,
      uploadedAt: schema.aiExtractSamplesTable.uploadedAt,
      confirmedAt: schema.aiExtractSamplesTable.confirmedAt,
      extractedRows: schema.aiExtractSamplesTable.extractedRows,
      pendingNamedRows: schema.aiExtractSamplesTable.pendingNamedRows,
      droppedRows: schema.aiExtractSamplesTable.droppedRows,
    })
    .from(schema.aiExtractSamplesTable)
    .where(sql`${schema.aiExtractSamplesTable.confirmedAt} IS NOT NULL`)
    .orderBy(desc(schema.aiExtractSamplesTable.uploadedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    weekStart: String(r.weekStart),
    customer: r.customer,
    fileName: r.fileName,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    uploadedAt: r.uploadedAt as Date,
    confirmedAt: r.confirmedAt as Date | null,
    pendingNamedRows: r.pendingNamedRows,
    extractedRowsLen: Array.isArray(r.extractedRows) ? r.extractedRows.length : 0,
    pendingRowsLen: Array.isArray(r.pendingNamedRows)
      ? r.pendingNamedRows.length
      : 0,
    droppedRowsLen: Array.isArray(r.droppedRows) ? r.droppedRows.length : 0,
  }));
}

function laneOf(s: SampleRow): Lane {
  return s.pendingNamedRows !== null ? "ai" : "parser";
}

async function loadSampleById(sampleId: number): Promise<SampleRow | null> {
  const rows = await db
    .select({
      id: schema.aiExtractSamplesTable.id,
      weekStart: schema.aiExtractSamplesTable.weekStart,
      customer: schema.aiExtractSamplesTable.customer,
      fileName: schema.aiExtractSamplesTable.fileName,
      mimeType: schema.aiExtractSamplesTable.mimeType,
      sizeBytes: schema.aiExtractSamplesTable.sizeBytes,
      uploadedAt: schema.aiExtractSamplesTable.uploadedAt,
      confirmedAt: schema.aiExtractSamplesTable.confirmedAt,
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
    weekStart: String(r.weekStart),
    customer: r.customer,
    fileName: r.fileName,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    uploadedAt: r.uploadedAt as Date,
    confirmedAt: r.confirmedAt as Date | null,
    pendingNamedRows: r.pendingNamedRows,
    extractedRowsLen: Array.isArray(r.extractedRows) ? r.extractedRows.length : 0,
    pendingRowsLen: Array.isArray(r.pendingNamedRows)
      ? r.pendingNamedRows.length
      : 0,
    droppedRowsLen: Array.isArray(r.droppedRows) ? r.droppedRows.length : 0,
  };
}

async function loadFullSampleForCache(sampleId: number) {
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

interface RunResult {
  sampleId: number;
  customer: string;
  weekStart: string;
  fileName: string;
  lane: Lane;
  isFirstUpload: boolean;
  durationMs: number;
  toolCalls: Array<{ name: string }>;
  inputTokens: number;
  outputTokens: number;
  verdict: unknown;
  validationError?: string;
  fatalError?: string;
}

async function runAnalysisForSample(
  client: Anthropic,
  sample: SampleRow,
  promptVersion: string,
): Promise<RunResult> {
  const lane = laneOf(sample);
  const isFirstUpload = await isFirstUploadForCustomer(sample.customer, sample.id);
  const system = buildAnalysisSystemPrompt({
    customer: sample.customer,
    weekStart: sample.weekStart,
    lane,
    isFirstUpload,
  });
  const fullSample = await loadFullSampleForCache(sample.id);
  if (!fullSample) {
    return {
      sampleId: sample.id,
      customer: sample.customer,
      weekStart: sample.weekStart,
      fileName: sample.fileName,
      lane,
      isFirstUpload,
      durationMs: 0,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      verdict: null,
      fatalError: "sample disappeared between list and run",
    };
  }

  const cache = new _internals.ChatToolCache();
  cache.preloadSample(fullSample);
  const evidence = new _internals.EvidenceAccumulator();
  const ctx = {
    weekStart: sample.weekStart,
    customer: sample.customer,
    cache,
    evidence,
  };
  const budget = new IngestionBudget({
    fileName: sample.fileName,
    customer: sample.customer,
  });

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

  const startedAt = Date.now();
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: `Analyze the just-confirmed upload for customer "${sample.customer}", payroll week starting ${sample.weekStart}, file "${sample.fileName}" (${sample.mimeType}, ${sample.sizeBytes} bytes, lane=${lane}). Call read tools as needed, then submit your verdict via ${SUBMIT_ANALYSIS_TOOL_NAME}.`,
    },
  ];

  const MAX_TURNS = 8;
  let totalIn = 0;
  let totalOut = 0;
  const toolCalls: Array<{ name: string }> = [];
  let verdictRaw: unknown = null;
  let fatalError: string | undefined;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Force submit_analysis on the final turn so we always close out.
      const forceSubmit = turn === MAX_TURNS - 1;
      const response = await client.messages.create(
        {
          model: DEFAULT_CLAUDE_MODEL,
          max_tokens: 2048,
          system,
          tools,
          messages,
          tool_choice: forceSubmit
            ? { type: "tool", name: SUBMIT_ANALYSIS_TOOL_NAME }
            : { type: "auto" },
        },
        { timeout: 90_000 },
      );
      totalIn += response.usage?.input_tokens ?? 0;
      totalOut += response.usage?.output_tokens ?? 0;
      budget.recordCall(
        {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          model: DEFAULT_CLAUDE_MODEL,
          provider: "claude",
        },
        "recipe_derivation",
      );

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
        toolCalls.push({ name: tu.name });
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
        const handled = await _internals.runTool(tu, ctx);
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
  const result: RunResult = {
    sampleId: sample.id,
    customer: sample.customer,
    weekStart: sample.weekStart,
    fileName: sample.fileName,
    lane,
    isFirstUpload,
    durationMs,
    toolCalls,
    inputTokens: totalIn,
    outputTokens: totalOut,
    verdict: verdictRaw,
  };
  if (fatalError) {
    result.fatalError = fatalError;
    return result;
  }

  const parsed = verdictPayloadSchema.safeParse(verdictRaw);
  if (!parsed.success) {
    result.validationError = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  } else {
    result.verdict = parsed.data;
  }
  return result;
}

function rubricFor(results: RunResult[], promptVersion: string): string {
  const lines: string[] = [];
  lines.push(`# Upload-analysis grading rubric — ${promptVersion}`);
  lines.push("");
  lines.push(
    "Fill `label` and `notes` during the synchronous grading session. " +
      "Allowed labels: `tp-acted`, `tp-noise`, `fp-misleading`, `fp-harmless`. " +
      "For each upload, also fill `falseNegatives` with the count of issues the verdict missed.",
  );
  lines.push("");
  for (const r of results) {
    lines.push("---");
    lines.push("");
    lines.push(
      `## Sample ${r.sampleId} — ${r.customer} — week ${r.weekStart}`,
    );
    lines.push("");
    lines.push(`- file: \`${r.fileName}\``);
    lines.push(`- lane: \`${r.lane}\``);
    lines.push(`- first upload for this customer: \`${r.isFirstUpload}\``);
    lines.push(
      `- tool calls: ${r.toolCalls.map((t) => t.name).join(", ") || "(none)"}`,
    );
    lines.push(
      `- tokens: in=${r.inputTokens} out=${r.outputTokens}, durationMs=${r.durationMs}`,
    );
    if (r.fatalError) {
      lines.push(`- **fatalError**: ${r.fatalError}`);
      lines.push("");
      continue;
    }
    if (r.validationError) {
      lines.push(`- **validationError**: ${r.validationError}`);
    }
    const v = r.verdict as
      | {
          verdict?: string;
          lane?: string;
          summary?: string;
          findings?: Array<{ kind: string; severity: string; message: string }>;
        }
      | null;
    lines.push(`- verdict: \`${v?.verdict ?? "(missing)"}\``);
    lines.push(`- summary: ${v?.summary ?? "(missing)"}`);
    lines.push("");
    lines.push(`| # | kind | severity | message | label | notes |`);
    lines.push(`| - | ---- | -------- | ------- | ----- | ----- |`);
    const findings = v?.findings ?? [];
    if (findings.length === 0) {
      lines.push(`| - | _(no findings)_ | | | | |`);
    } else {
      findings.forEach((f: { kind: string; severity: string; message: string }, i: number) => {
        const msg = (f.message ?? "").replace(/\|/g, "\\|");
        lines.push(`| ${i + 1} | ${f.kind} | ${f.severity} | ${msg} |  |  |`);
      });
    }
    lines.push("");
    lines.push(`falseNegatives: <fill in: count of issues the verdict missed>`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = parseArgs(process.argv);
  if (argv.cmd === "help") {
    printHelp();
    process.exit(0);
  }
  if (argv.cmd === "list") {
    const samples = await listRecentConfirmedSamples(argv.limit);
    if (samples.length === 0) {
      console.log("(no confirmed samples found)");
      process.exit(0);
    }
    console.log(
      `id  | lane   | week       | customer (first 24) | rows R/P/D | file`,
    );
    console.log("-".repeat(110));
    for (const s of samples) {
      const lane = laneOf(s);
      const cust = s.customer.padEnd(24).slice(0, 24);
      const counts =
        `${s.extractedRowsLen}/${s.pendingRowsLen}/${s.droppedRowsLen}`.padEnd(10);
      console.log(
        `${String(s.id).padStart(4)} | ${lane.padEnd(6)} | ${s.weekStart} | ${cust} | ${counts} | ${s.fileName}`,
      );
    }
    console.log("");
    console.log(
      `Pick 8-10 (>=3 ai, >=3 parser, >=1 known-bad) and run:` +
        `\n  pnpm --filter @workspace/api-server prototype-upload-analysis run --samples <ids> --version ${PROMPT_VERSION}`,
    );
    process.exit(0);
  }

  // cmd === 'run'
  if (argv.sampleIds.length === 0) {
    console.error("--samples required for `run`");
    process.exit(2);
  }

  const client = getClaudeClient();
  const outDir = resolve(process.cwd(), ".local/prototype");
  await mkdir(outDir, { recursive: true });
  const jsonPath = resolve(
    outDir,
    `upload-analysis-verdicts-${argv.version}.json`,
  );
  const mdPath = resolve(outDir, `grading-rubric-${argv.version}.md`);
  await mkdir(dirname(jsonPath), { recursive: true });

  const results: RunResult[] = [];
  for (const sid of argv.sampleIds) {
    const sample = await loadSampleById(sid);
    if (!sample) {
      console.error(`sample ${sid} not found — skipping`);
      results.push({
        sampleId: sid,
        customer: "(unknown)",
        weekStart: "(unknown)",
        fileName: "(unknown)",
        lane: "ai",
        isFirstUpload: false,
        durationMs: 0,
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        verdict: null,
        fatalError: "sample not found",
      });
      continue;
    }
    console.log(
      `[${sid}] ${sample.customer} ${sample.weekStart} ${sample.fileName} lane=${laneOf(sample)} ...`,
    );
    const r = await runAnalysisForSample(client, sample, argv.version);
    console.log(
      `  -> verdict=${(r.verdict as { verdict?: string } | null)?.verdict ?? "(none)"} findings=${(r.verdict as { findings?: unknown[] } | null)?.findings?.length ?? "?"} ${r.fatalError ? `FATAL: ${r.fatalError}` : r.validationError ? `INVALID: ${r.validationError}` : "ok"}`,
    );
    results.push(r);
  }

  const out = {
    promptVersion: argv.version,
    runAt: new Date().toISOString(),
    sampleIds: argv.sampleIds,
    results,
  };
  await writeFile(jsonPath, JSON.stringify(out, null, 2));
  await writeFile(mdPath, rubricFor(results, argv.version));
  console.log("");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  process.exit(0);
}

await main();
