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
 * Two ceilings, two different jobs (Task #336):
 *
 *  - **Token ceiling** (`MAX_TOKENS_PER_UPLOAD = 400_000`, input + output
 *    combined). This is the real spend guard. Static, never relaxed.
 *  - **Call ceiling** (per-upload dynamic). Sized at upload start from
 *    the planned chunk count via `computeMaxCalls(plannedChunks)`. A
 *    flat 4-chunk Burnett gets ~18 calls; a block-structured 71-chunk
 *    Adient gets ~152. Both share the same `BACKSTOP_MAX_CALLS_PER_UPLOAD = 200`
 *    absolute cap so a bug in chunk planning can't authorize unbounded
 *    calls. Single-call / image / pdf paths leave the default backstop
 *    in place — they don't chunk by rows.
 *
 * The soft-warn threshold tracks the configured ceiling
 * (`SOFT_WARN_FRACTION` of `maxCalls`) so it still fires "running hot"
 * regardless of file shape.
 */
export const BACKSTOP_MAX_CALLS_PER_UPLOAD = 200;
/** Floor for the dynamic ceiling so small files still get a sane budget. */
export const MIN_MAX_CALLS_PER_UPLOAD = 20;
/**
 * Backwards-compatible alias for the old constant. Callers that didn't
 * size their budget per-upload (e.g. test harnesses) still get the
 * backstop. The trip-check itself reads the per-instance `maxCalls`.
 */
export const MAX_CALLS_PER_UPLOAD = BACKSTOP_MAX_CALLS_PER_UPLOAD;
export const MAX_TOKENS_PER_UPLOAD = 400_000;
/** Soft warn fires once when totalCalls crosses this fraction of `maxCalls`. */
export const SOFT_WARN_FRACTION = 0.66;

/**
 * Right-size the per-upload call ceiling from the planned chunk count.
 *   `(plannedChunks × 2) + 10`, clamped between `MIN_MAX_CALLS_PER_UPLOAD`
 *   and `BACKSTOP_MAX_CALLS_PER_UPLOAD`.
 *
 * The `×2 + 10` shape leaves room for: 1 primary call per chunk, a
 * second model call for the NDJSON re-issue retry on a few chunks
 * (Task #308), the occasional `withModelRetry` retry on a transient
 * 429/5xx, plus the few non-chunk calls (structure probe, recipe
 * derivation in future) that share the budget.
 */
export function computeMaxCalls(plannedChunks: number): number {
  const raw = Math.max(0, Math.floor(plannedChunks)) * 2 + 10;
  if (raw < MIN_MAX_CALLS_PER_UPLOAD) return MIN_MAX_CALLS_PER_UPLOAD;
  if (raw > BACKSTOP_MAX_CALLS_PER_UPLOAD) return BACKSTOP_MAX_CALLS_PER_UPLOAD;
  return raw;
}

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
   * Task #336: the per-upload call ceiling this budget was configured
   * with. Right-sized from the planned chunk count for xlsx uploads;
   * `BACKSTOP_MAX_CALLS_PER_UPLOAD` for non-xlsx paths and for budgets
   * the caller never resized. Surfaced on `ingest_done` + the
   * persisted `ingestion_runs` row so operators can see how close any
   * given upload ran to its own limit.
   */
  maxCalls: number;
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
  private maxCalls: number;
  private readonly maxCallsOverride: number | null;
  private readonly log: BudgetLogger;
  private readonly fileName: string;
  private readonly customer: string;

  constructor(opts: {
    fileName: string;
    customer: string;
    log?: BudgetLogger;
    /**
     * Optional initial call ceiling. Defaults to the backstop; the
     * xlsx branch in `aiExtract.ts` resizes it via `setMaxCalls` once
     * the planned chunk count is known.
     */
    maxCalls?: number;
    /**
     * Task #356: admin-supplied per-upload floor that subsequent
     * `setMaxCalls` calls (e.g. the xlsx chunker's auto-sizing) are
     * never allowed to drop below. Clamped to
     * `[MIN_MAX_CALLS_PER_UPLOAD, BACKSTOP_MAX_CALLS_PER_UPLOAD]`.
     * When set, the initial `maxCalls` is also raised to at least
     * this value so a `?maxCalls=` retry actually authorizes more
     * calls regardless of what the caller passed for the default.
     */
    maxCallsOverride?: number;
  }) {
    this.fileName = opts.fileName;
    this.customer = opts.customer;
    this.log = opts.log ?? logger;
    this.maxCallsOverride =
      opts.maxCallsOverride != null
        ? this.clampMaxCalls(opts.maxCallsOverride)
        : null;
    const initial = this.clampMaxCalls(
      opts.maxCalls ?? BACKSTOP_MAX_CALLS_PER_UPLOAD,
    );
    this.maxCalls =
      this.maxCallsOverride != null
        ? Math.max(initial, this.maxCallsOverride)
        : initial;
  }

  private clampMaxCalls(n: number): number {
    if (!Number.isFinite(n) || n < MIN_MAX_CALLS_PER_UPLOAD) {
      return MIN_MAX_CALLS_PER_UPLOAD;
    }
    if (n > BACKSTOP_MAX_CALLS_PER_UPLOAD) {
      return BACKSTOP_MAX_CALLS_PER_UPLOAD;
    }
    return Math.floor(n);
  }

  /**
   * Resize the per-upload call ceiling. Called once from the xlsx
   * branch in `aiExtract.ts` after the chunker has decided how many
   * chunks the file will be split into. Clamped to
   * `[MIN_MAX_CALLS_PER_UPLOAD, BACKSTOP_MAX_CALLS_PER_UPLOAD]`.
   */
  setMaxCalls(n: number): void {
    const clamped = this.clampMaxCalls(n);
    this.maxCalls =
      this.maxCallsOverride != null
        ? Math.max(clamped, this.maxCallsOverride)
        : clamped;
  }

  /** The configured per-upload call ceiling, post-clamp. */
  getMaxCalls(): number {
    return this.maxCalls;
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
    const softWarnAt = Math.max(1, Math.floor(this.maxCalls * SOFT_WARN_FRACTION));

    if (!this.warned && this.totalCalls >= softWarnAt) {
      this.warned = true;
      this.log.warn(
        {
          fileName: this.fileName,
          customer: this.customer,
          calls: this.totalCalls,
          totalTokens,
          totalCostUsd: this.totalCostUsd,
          maxCalls: this.maxCalls,
          softWarnAt,
          maxTokens: MAX_TOKENS_PER_UPLOAD,
          byPurpose: this.byPurpose,
        },
        "AI extraction running hot — soft-warn threshold crossed (still under hard limit)",
      );
    }

    if (this.totalCalls > this.maxCalls) {
      throw new IngestionBudgetExceeded(
        `AI extraction stopped: this upload would exceed the per-file safety limit of ${this.maxCalls} model calls (currently ${this.totalCalls}). Split the file into smaller pieces, or contact an admin to raise the cap.`,
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
      maxCalls: this.maxCalls,
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
      maxCalls: this.maxCalls,
      blockStructured: this.blockStructured,
      rowsPerChunk: this.rowsPerChunk,
      pacerWaitMs: this.pacerWaitMs,
    };
  }
}
