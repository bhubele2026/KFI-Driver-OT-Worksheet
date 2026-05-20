import { logger } from "../logger.js";

/**
 * Provider-agnostic content shape passed to a `ModelClient`. Mirrors the
 * intersection of what Gemini's `contents.parts` and Claude's
 * `messages.content` arrays accept: either a text segment or an inline
 * binary attachment (image or PDF) carried as base64.
 */
export type ContentPart =
  | { kind: "text"; text: string }
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
      const base = Math.min(8000, 1500 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * Math.floor(base * 0.3));
      const delayMs = base + jitter;
      (opts.log ?? logger).warn(
        {
          label: opts.label,
          attempt,
          maxAttempts,
          status: getStatus(err),
          errMsg: err instanceof Error ? err.message : String(err),
          delayMs,
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
