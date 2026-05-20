import { logger } from "../logger.js";
import { costUsd } from "./pricing.js";

/**
 * Per-upload spend / call ceiling for the AI customer-file extraction
 * pipeline. Wrapped around every model-call site in `aiExtract.ts` so a
 * single pathological upload (the TriEnda-class case that motivated
 * Task #297 — 763 rows, ~1M tokens, ~500s, ~$3 of Claude before failing)
 * can't burn unbounded provider spend before the dispatcher even
 * sees an error.
 *
 * Hard limits chosen so the worst LEGITIMATE upload (a fresh
 * Penda/TriEnda format with no schema-cache hit, ~25 chunks @ 6
 * concurrency, no retries) clears comfortably while the
 * pathological retry-storm path trips early:
 *   - 30 calls / upload
 *   - 400k tokens / upload (input + output, combined)
 *
 * Soft warn at 20 calls so the API log shows the upload was running hot
 * even when it ultimately succeeded, giving us a leading indicator for
 * future format-drift incidents before they tip into a full trip.
 */
export const MAX_CALLS_PER_UPLOAD = 30;
export const MAX_TOKENS_PER_UPLOAD = 400_000;
export const SOFT_WARN_CALLS = 20;

/**
 * What kind of model call this is, recorded per-call so the
 * `ingest_done` summary and the persisted `ingestion_runs` row tell us
 * whether the budget was eaten by legitimate per-chunk work or by a
 * compounding retry pathology. Keep the set small and stable — the
 * admin UI groups by these.
 */
export type IngestionPurpose =
  | "structure_probe" // future: cheap pre-chunk probe (not used yet)
  | "chunk" // primary per-chunk model call
  | "chunk_retry" // withModelRetry retry on the same chunk
  | "chunk_reissue" // targeted re-issue of missing NDJSON row IDs (Task #308)
  | "gemini_fallback" // Claude failed, Gemini took the call (opt-in)
  | "recipe_derivation"; // future: derive a deterministic recipe (not used yet)

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
}

export interface PurposeTally {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type TripReason = "max_calls" | "max_tokens";

export interface IngestionBudgetDiagnostics {
  tripReason: TripReason;
  callsAtTrip: number;
  tokensAtTrip: number;
  costUsdAtTrip: number;
  maxCalls: number;
  maxTokens: number;
  byPurpose: Record<string, PurposeTally>;
  byProvider: Record<string, PurposeTally>;
}

/**
 * Thrown by `IngestionBudget.recordCall` when the upload exceeds either
 * the per-upload call ceiling or the per-upload token ceiling. The
 * upload route catches this, logs `ingest_done` + writes an
 * `ingestion_runs` row with `outcome='budget_exceeded'`, and returns a
 * dispatcher-actionable 400 instead of letting the model loop continue.
 */
export class IngestionBudgetExceeded extends Error {
  readonly diagnostics: IngestionBudgetDiagnostics;
  constructor(message: string, diagnostics: IngestionBudgetDiagnostics) {
    super(message);
    this.name = "IngestionBudgetExceeded";
    this.diagnostics = diagnostics;
  }
}

export interface IngestionBudgetSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byPurpose: Record<string, PurposeTally>;
  byProvider: Record<string, PurposeTally>;
  geminiFallbackUsed: boolean;
  warnedHot: boolean;
  /**
   * Task #307: xlsx layout the chunker saw at extract time.
   * True for "block-structured" exports (e.g. Adient: a header band that
   * repeats once per driver) where we halve the per-chunk row budget so
   * Claude doesn't truncate mid-block. Null when the upload didn't go
   * through the xlsx path (image / pdf / single-call) — those paths
   * don't chunk by rows.
   */
  blockStructured: boolean | null;
  /**
   * Per-chunk row cap that the xlsx chunker actually used for this
   * upload. 60 for block-structured layouts, 120 for flat layouts, null
   * for non-xlsx paths.
   */
  rowsPerChunk: number | null;
  /**
   * Total ms spent sleeping inside `TokenPacer.acquire()` across every
   * chunk of this upload (Task #314). When near zero the upload was
   * model-bound; when it dominates `wallTimeMs` the upload was
   * pacer-bound and the operator should suspect TPM-ceiling contention
   * (other concurrent uploads, or events not yet released).
   */
  pacerWaitMs: number;
}

/** Minimal logger shape — accepts req.log (pino child) or the module logger. */
type BudgetLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

function emptyTally(): PurposeTally {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export class IngestionBudget {
  private totalCalls = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private readonly byPurpose: Record<string, PurposeTally> = {};
  private readonly byProvider: Record<string, PurposeTally> = {};
  private warned = false;
  private geminiFallbackUsed = false;
  private blockStructured: boolean | null = null;
  private rowsPerChunk: number | null = null;
  private pacerWaitMs = 0;
  private readonly log: BudgetLogger;
  private readonly fileName: string;
  private readonly customer: string;

  constructor(opts: {
    fileName: string;
    customer: string;
    log?: BudgetLogger;
  }) {
    this.fileName = opts.fileName;
    this.customer = opts.customer;
    this.log = opts.log ?? logger;
  }

  /**
   * Record a single model call. Increments per-purpose + per-provider
   * tallies and throws `IngestionBudgetExceeded` if EITHER the call
   * ceiling or the token ceiling has now been crossed. Emits one
   * structured WARN the first time soft-warn threshold trips, so a
   * legitimate-but-hot upload shows up in the API log even when it
   * ultimately succeeds.
   */
  recordCall(usage: CallUsage, purpose: IngestionPurpose): void {
    const cost = costUsd(usage.model, usage.inputTokens, usage.outputTokens);
    this.totalCalls += 1;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalCostUsd += cost;

    const pTally = this.byPurpose[purpose] ?? emptyTally();
    pTally.calls += 1;
    pTally.inputTokens += usage.inputTokens;
    pTally.outputTokens += usage.outputTokens;
    pTally.costUsd += cost;
    this.byPurpose[purpose] = pTally;

    const provTally = this.byProvider[usage.provider] ?? emptyTally();
    provTally.calls += 1;
    provTally.inputTokens += usage.inputTokens;
    provTally.outputTokens += usage.outputTokens;
    provTally.costUsd += cost;
    this.byProvider[usage.provider] = provTally;

    if (purpose === "gemini_fallback") this.geminiFallbackUsed = true;

    const totalTokens = this.totalInputTokens + this.totalOutputTokens;

    if (!this.warned && this.totalCalls >= SOFT_WARN_CALLS) {
      this.warned = true;
      this.log.warn(
        {
          fileName: this.fileName,
          customer: this.customer,
          calls: this.totalCalls,
          totalTokens,
          totalCostUsd: this.totalCostUsd,
          maxCalls: MAX_CALLS_PER_UPLOAD,
          maxTokens: MAX_TOKENS_PER_UPLOAD,
          byPurpose: this.byPurpose,
        },
        "AI extraction running hot — soft-warn threshold crossed (still under hard limit)",
      );
    }

    if (this.totalCalls > MAX_CALLS_PER_UPLOAD) {
      throw new IngestionBudgetExceeded(
        `AI extraction stopped: this upload would exceed the per-file safety limit of ${MAX_CALLS_PER_UPLOAD} model calls (currently ${this.totalCalls}). Split the file into smaller pieces, or contact an admin to raise the cap.`,
        this.makeDiagnostics("max_calls"),
      );
    }
    if (totalTokens > MAX_TOKENS_PER_UPLOAD) {
      throw new IngestionBudgetExceeded(
        `AI extraction stopped: this upload would exceed the per-file safety limit of ${MAX_TOKENS_PER_UPLOAD.toLocaleString()} tokens (currently ${totalTokens.toLocaleString()}). Split the file into smaller pieces, or contact an admin to raise the cap.`,
        this.makeDiagnostics("max_tokens"),
      );
    }
  }

  /** Mark the geminiFallbackUsed flag without recording a call (used when the call itself is also recorded). */
  markGeminiFallbackUsed(): void {
    this.geminiFallbackUsed = true;
  }

  /**
   * Roll the ms returned by `TokenPacer.acquire()` into this upload's
   * pacer-wait total (Task #314). Called once per chunk dispatch so
   * the `ingest_done` summary and the persisted `ingestion_runs` row
   * surface how much wall time was eaten by Anthropic-TPM throttling.
   */
  addPacerWait(ms: number): void {
    if (ms > 0) this.pacerWaitMs += ms;
  }

  isSoftWarned(): boolean {
    return this.warned;
  }

  hasGeminiFallback(): boolean {
    return this.geminiFallbackUsed;
  }

  /**
   * Task #307: record the xlsx layout decision the chunker made for
   * this upload (block-structured vs flat, and the per-chunk row cap
   * it used). Called once from the xlsx branch in `runExtraction`;
   * surfaced in the `ingest_done` log + persisted `ingestion_runs`
   * row so we can later confirm Adient is detected end-to-end.
   */
  recordXlsxLayout(opts: { blockStructured: boolean; rowsPerChunk: number }): void {
    this.blockStructured = opts.blockStructured;
    this.rowsPerChunk = opts.rowsPerChunk;
  }

  private makeDiagnostics(tripReason: TripReason): IngestionBudgetDiagnostics {
    return {
      tripReason,
      callsAtTrip: this.totalCalls,
      tokensAtTrip: this.totalInputTokens + this.totalOutputTokens,
      costUsdAtTrip: this.totalCostUsd,
      maxCalls: MAX_CALLS_PER_UPLOAD,
      maxTokens: MAX_TOKENS_PER_UPLOAD,
      byPurpose: this.byPurpose,
      byProvider: this.byProvider,
    };
  }

  summary(): IngestionBudgetSummary {
    return {
      totalCalls: this.totalCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
      totalCostUsd: this.totalCostUsd,
      byPurpose: this.byPurpose,
      byProvider: this.byProvider,
      geminiFallbackUsed: this.geminiFallbackUsed,
      warnedHot: this.warned,
      blockStructured: this.blockStructured,
      rowsPerChunk: this.rowsPerChunk,
      pacerWaitMs: this.pacerWaitMs,
    };
  }
}
