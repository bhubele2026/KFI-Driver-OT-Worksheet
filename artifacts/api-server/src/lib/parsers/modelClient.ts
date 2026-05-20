import { logger } from "../logger.js";

/**
 * Provider-agnostic content shape passed to a `ModelClient`. Mirrors the
 * intersection of what Gemini's `contents.parts` and Claude's
 * `messages.content` arrays accept: either a text segment or an inline
 * binary attachment (image or PDF) carried as base64.
 */
export type ContentPart =
  | {
      kind: "text";
      text: string;
      /**
       * Task #296: when true, providers that support prompt caching
       * should mark this block as cacheable. Anthropic's Claude honors
       * this via `cache_control: { type: "ephemeral" }` so the prefix
       * (role, rules, roster, schema example) is reused at the cache
       * discount on chunks 2..N of the same upload — dropping the
       * per-chunk input-token cost of cached content by ~90%. Gemini
       * silently ignores the flag.
       */
      cacheable?: boolean;
    }
  | { kind: "inlineData"; mimeType: string; data: string };

/**
 * Tiny abstraction over the two AI providers wired into customer-file
 * extraction. The provider picker (`getModelClient`) returns the right
 * implementation based on `AI_EXTRACT_PROVIDER`; the parser path in
 * `aiExtract.ts` never sees the underlying SDK directly. Adding a third
 * provider only means implementing this interface and wiring it into
 * the picker — no changes to the chunking, prompt, salvage, or
 * AI-sample retention code.
 */
export interface ModelClient {
  /** Short human-readable name used in log lines (e.g. "claude", "gemini"). */
  name: string;
  /**
   * Single round-trip JSON generation. Implementations are responsible for
   * applying their per-request timeout; callers do not race externally.
   * `jsonSchema` is an optional structured-output hint — Gemini honors it
   * via `responseSchema`; Claude relies on the prompt's "return strictly
   * JSON" instruction and ignores the schema (the existing
   * `parseOrSalvage` recovery handles minor format slips).
   */
  generate(opts: {
    parts: ContentPart[];
    maxOutputTokens: number;
    timeoutMs: number;
    jsonSchema?: unknown;
  }): Promise<{ text: string; usage: ModelCallUsage }>;
}

/**
 * Per-call token + model attribution surfaced by both providers. Wired
 * into `IngestionBudget.recordCall` so the per-upload spend ceiling
 * (Task #297) sees real provider-reported token counts instead of
 * char-length guesses. `model` is the concrete provider model id (e.g.
 * "claude-sonnet-4-5", "gemini-2.5-flash"); `provider` is the short
 * label exposed by `ModelClient.name`.
 */
export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
}

/** Minimal logger shape — accepts req.log (pino child) or the module logger. */
export type SalvageLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * Pull a useful HTTP-ish status code out of whatever shape the provider
 * SDK threw. Anthropic's SDK exposes `.status`; @google/genai surfaces
 * `.error.code`; native fetch errors have neither.
 */
function getStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; error?: { code?: unknown } };
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (e.error && typeof e.error.code === "number") return e.error.code;
  return undefined;
}

/**
 * Best-effort `retry-after` (ms) extracted from a thrown provider error.
 * Task #296: when Anthropic returns 429 RATELIMIT_EXCEEDED on the
 * per-minute input-tokens window, the response carries either a
 * `retry-after` header (seconds, integer or HTTP-date) or an
 * `anthropic-ratelimit-input-tokens-reset` header (ISO timestamp). We
 * honor that hint instead of our generic 1.5s→8s exponential backoff
 * so a chunk pool that hit the 30k tokens/min ceiling pauses long
 * enough for the window to roll rather than re-firing into the same
 * wall. Capped at 70s so a stuck chunk doesn't stall the worker pool
 * forever — the outer per-upload IngestionBudget is the ultimate
 * safety net. Returns `undefined` when the error has no usable
 * rate-limit hint; callers fall back to generic exponential backoff.
 */
export function parseRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  // Anthropic SDK errors expose a real fetch-spec Headers object.
  // Other SDKs (Gemini, raw fetch) may surface a plain object — try both.
  const e = err as { headers?: unknown };
  const h = e.headers;
  const readHeader = (name: string): string | null => {
    if (!h) return null;
    if (typeof (h as Headers).get === "function") {
      try {
        return (h as Headers).get(name);
      } catch {
        return null;
      }
    }
    if (typeof h === "object") {
      const rec = h as Record<string, unknown>;
      const v =
        rec[name] ??
        rec[name.toLowerCase()] ??
        rec[name.toUpperCase()];
      return typeof v === "string" ? v : null;
    }
    return null;
  };
  const cap = 70_000;
  const retryAfter = readHeader("retry-after");
  if (retryAfter) {
    // `retry-after` is either a decimal seconds count or an HTTP-date.
    const asNum = Number(retryAfter);
    if (Number.isFinite(asNum) && asNum >= 0) {
      return Math.min(cap, Math.ceil(asNum * 1000));
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      const ms = asDate - Date.now();
      if (ms > 0) return Math.min(cap, ms);
    }
  }
  // Anthropic-specific reset hint. Two observed shapes: an ISO
  // timestamp ("2026-05-20T18:31:00Z") and a bare seconds count.
  const reset = readHeader("anthropic-ratelimit-input-tokens-reset");
  if (reset) {
    const asDate = Date.parse(reset);
    if (!Number.isNaN(asDate)) {
      const ms = asDate - Date.now();
      if (ms > 0) return Math.min(cap, ms);
    }
    const asNum = Number(reset);
    if (Number.isFinite(asNum) && asNum >= 0) {
      return Math.min(cap, Math.ceil(asNum * 1000));
    }
  }
  return undefined;
}

/**
 * Treat 429 / 503 / 5xx and well-known transient network errors as
 * retryable. Everything else (auth, schema, 4xx) fails fast so the
 * dispatcher sees the real cause instead of a watered-down timeout.
 */
export function isRetryableModelError(err: unknown): boolean {
  const status = getStatus(err);
  if (status === 429 || status === 503) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  const msg = err instanceof Error ? err.message : "";
  return /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|socket hang up|network/i.test(msg);
}

/**
 * Run `fn` with retry-on-transient-failure. Up to `maxAttempts` (default 3)
 * tries total, with jittered exponential backoff starting at 1.5s and
 * capped at 8s. Logs one WARN per retry so we can correlate dispatcher
 * complaints with provider hiccups; the final failure is rethrown
 * unchanged so error-shape regressions stay caught upstream.
 */
export async function withModelRetry<T>(
  fn: () => Promise<T>,
  opts: { label: string; log?: SalvageLogger; maxAttempts?: number },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableModelError(err);
      if (attempt === maxAttempts || !retryable) throw err;
      // Task #296: when the provider returns a 429 with a usable
      // `retry-after` (or Anthropic's `anthropic-ratelimit-*-reset`)
      // header, sleep that long instead of our generic 1.5s→8s
      // exponential. The tier-1 Anthropic ceiling is 30k input
      // tokens/min, so a single oversize first chunk can trip the
      // limit and the only useful delay is "until the window rolls".
      const hintMs = parseRetryAfterMs(err);
      const base = Math.min(8000, 1500 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.floor(base * 0.3));
      const delayMs = hintMs ?? base + jitter;
      (opts.log ?? logger).warn(
        {
          label: opts.label,
          attempt,
          maxAttempts,
          status: getStatus(err),
          errMsg: err instanceof Error ? err.message : String(err),
          delayMs,
          retryAfterHonored: hintMs !== undefined,
        },
        "AI model call failed transiently — retrying after backoff",
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Run `fn(idx)` for every index 0..count-1, never holding more than
 * `concurrency` calls in flight. Preserves index→result ordering so
 * downstream callers (e.g. the chunked-extract merger) can rely on
 * stable ordering for the schema-cache recorder. The `onAbort` callback
 * lets a caller flip a cooperative-cancel flag so other workers stop
 * dequeuing as soon as the first failure trips.
 */
export async function runWithConcurrency<T>(
  count: number,
  concurrency: number,
  fn: (idx: number) => Promise<T>,
  opts?: { isAborted?: () => boolean },
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), count);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!(opts?.isAborted?.() ?? false)) {
      const idx = next++;
      if (idx >= count) break;
      results[idx] = await fn(idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Process-wide token-bucket pacer for Anthropic input tokens (Task #296).
 *
 * Anthropic tier-1 caps Claude Sonnet 4.5 at 30,000 input tokens per
 * minute. With prompt caching applied to the chunked-xlsx prefix the
 * per-chunk new-input tokens drop to roughly the per-chunk CSV body
 * (~3-6k tokens), but a worker pool of 3 chunks @ 6k each = 18k/min
 * sustained is right at the edge — and the first chunk pays the full
 * prefix on cache_creation. The pacer is a leaky bucket sized at 25k
 * tokens / 60s (a deliberate buffer below the documented ceiling so
 * one estimation slip doesn't trip 429). Workers `await acquire(est)`
 * before dispatching; oversize requests block until enough capacity
 * has freed up. Operates only on the Claude provider; the Gemini
 * pacer is a no-op because its TPM ceiling is an order of magnitude
 * higher.
 *
 * Token estimation is char-based (`Math.ceil(chars/4)`) — close enough
 * to BPE tokenization for the rate-shaping use case; the IngestionBudget
 * uses the actual usage numbers reported back by the SDK.
 */
export interface TokenPacer {
  acquire(estimatedTokens: number): Promise<void>;
  /** @internal test seam */
  _state(): { capacity: number; windowMs: number; pending: number };
}

class LeakyBucketPacer implements TokenPacer {
  private events: Array<{ at: number; tokens: number }> = [];
  private waiters: Array<() => void> = [];
  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}
  private prune(): number {
    const cutoff = this.now() - this.windowMs;
    while (this.events.length > 0 && this.events[0].at <= cutoff) {
      this.events.shift();
    }
    let used = 0;
    for (const e of this.events) used += e.tokens;
    return used;
  }
  async acquire(estimatedTokens: number): Promise<void> {
    const want = Math.max(0, Math.ceil(estimatedTokens));
    // Single-shot requests larger than the whole bucket can never fit —
    // clamp the reservation to the capacity so they still get scheduled
    // (and pay the full window's wait afterward via subsequent prunes).
    const reservation = Math.min(want, this.capacity);
    for (;;) {
      const used = this.prune();
      if (used + reservation <= this.capacity) {
        this.events.push({ at: this.now(), tokens: reservation });
        return;
      }
      // Wait until the oldest event ages out — that's the earliest
      // possible moment new headroom appears.
      const oldest = this.events[0];
      const waitMs = Math.max(50, oldest.at + this.windowMs - this.now() + 25);
      await this.sleep(waitMs);
    }
  }
  _state() {
    return {
      capacity: this.capacity,
      windowMs: this.windowMs,
      pending: this.waiters.length,
    };
  }
}

const _pacersByProvider = new Map<string, TokenPacer>();
function noopPacer(): TokenPacer {
  return {
    acquire: async () => {},
    _state: () => ({ capacity: Infinity, windowMs: 0, pending: 0 }),
  };
}
export function getTokenPacer(providerName: string): TokenPacer {
  const key = providerName.toLowerCase();
  const cached = _pacersByProvider.get(key);
  if (cached) return cached;
  if (key === "claude") {
    // 25k tokens / 60s — 5k headroom below the documented 30k tier-1
    // ceiling. Override only via the test seam below.
    const p = new LeakyBucketPacer(25_000, 60_000);
    _pacersByProvider.set(key, p);
    return p;
  }
  const np = noopPacer();
  _pacersByProvider.set(key, np);
  return np;
}

/** @internal test seam — replace (or reset) the pacer for a provider. */
export function __setTestTokenPacer(providerName: string, pacer: TokenPacer | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestTokenPacer is a test seam — not callable in production");
  }
  if (pacer) _pacersByProvider.set(providerName.toLowerCase(), pacer);
  else _pacersByProvider.delete(providerName.toLowerCase());
}

/** @internal test seam — construct a pacer with custom limits + clock. */
export function __makeTestLeakyBucketPacer(
  capacity: number,
  windowMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): TokenPacer {
  return new LeakyBucketPacer(capacity, windowMs, now, sleep);
}

/**
 * Rough char→token estimator for the pacer. Mirrors Anthropic's
 * documented "~4 chars per token" rule of thumb. The real input-tokens
 * usage is recorded against the IngestionBudget post-call from the
 * SDK's `usage` object.
 */
export function estimatePromptTokens(parts: ContentPart[]): number {
  let chars = 0;
  for (const p of parts) {
    if (p.kind === "text") chars += p.text.length;
    else chars += p.data.length; // base64 chars roughly correlate to inline-image token count
  }
  return Math.ceil(chars / 4);
}

// Test-only seam. When set, `getModelClient` returns this instead of
// constructing the configured provider. Lets the retry / fallback tests
// drive deterministic failure sequences without touching the real
// providers. Gated on NODE_ENV at the push site below.
let _testClient: ModelClient | null = null;

/** @internal test seam — pin the model client used by aiExtract. */
export function __setTestModelClient(c: ModelClient | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestModelClient is a test seam — not callable in production");
  }
  _testClient = c;
}

/**
 * Provider picker. Reads `AI_EXTRACT_PROVIDER` (defaults to "claude"
 * post-Task #293) and constructs the matching client lazily so that an
 * unconfigured Gemini installation doesn't crash boot for Claude users.
 * Throws a dispatcher-actionable error if the chosen provider's
 * credentials aren't set.
 */
export async function getModelClient(): Promise<ModelClient> {
  if (_testClient) return _testClient;
  const provider = (process.env.AI_EXTRACT_PROVIDER ?? "claude").toLowerCase();
  if (provider === "gemini") {
    const { GeminiModelClient } = await import("./gemini.js");
    return new GeminiModelClient();
  }
  if (provider !== "claude") {
    throw new Error(
      `AI extraction: unknown AI_EXTRACT_PROVIDER="${provider}". Use "claude" or "gemini".`,
    );
  }
  const { ClaudeModelClient } = await import("./claude.js");
  return new ClaudeModelClient();
}

/**
 * Best-effort fallback client used when the primary provider throws a
 * non-retryable connectivity failure (e.g. DNS dead, 5xx after all
 * retries). Returns null when no fallback is wired so callers can
 * propagate the original error unchanged. Symmetric with the picker:
 * if Claude is primary we try Gemini, and vice versa, ONLY when the
 * fallback's credentials are configured.
 */
export async function getFallbackModelClient(primary: ModelClient): Promise<ModelClient | null> {
  if (_testClient) return null;
  const provider = (process.env.AI_EXTRACT_PROVIDER ?? "claude").toLowerCase();
  try {
    if (provider === "claude" && process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
      const { GeminiModelClient } = await import("./gemini.js");
      const fb = new GeminiModelClient();
      return fb.name === primary.name ? null : fb;
    }
    if (provider === "gemini" && process.env.ANTHROPIC_API_KEY) {
      const { ClaudeModelClient } = await import("./claude.js");
      const fb = new ClaudeModelClient();
      return fb.name === primary.name ? null : fb;
    }
  } catch {
    return null;
  }
  return null;
}
