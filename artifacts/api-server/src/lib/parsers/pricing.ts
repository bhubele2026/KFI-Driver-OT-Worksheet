/**
 * Per-provider, per-model token pricing in USD per 1M tokens. Used by
 * `IngestionBudget` and the `ingest_done` cost summary so we can put a
 * real-dollars number on every upload instead of staring at raw token
 * counts. Conservative: blended input rate (no cache-hit discount —
 * Task #296 will add prompt caching later), output-rate snapshot as of
 * May 2026. When provider list prices change, edit this table; nothing
 * else in the pipeline reads pricing.
 */

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude Sonnet 4.5 — $3 / $15 per 1M (input/output).
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  // Anthropic Claude Opus — $15 / $75 per 1M (input/output). Used by the
  // per-upload reviewer (Task #446); list-price snapshot, update here if
  // Anthropic changes Opus pricing.
  "claude-opus-4-8": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-opus-4-1": { inputPerMillion: 15, outputPerMillion: 75 },
  // Google Gemini 2.5 Flash — $0.30 / $2.50 per 1M (input/output).
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

// Fallback when an unrecognized model name surfaces (e.g. a future
// `claude-sonnet-4-6` rollout before this table is updated). Picks the
// more expensive Claude row so we'd rather over-estimate than silently
// under-bill the upload's budget bucket.
const FALLBACK_PRICING: ModelPricing = PRICING["claude-opus-4-8"];

export function getPricing(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK_PRICING;
}

/** Compute USD cost for one call. */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = getPricing(model);
  return (
    (inputTokens * p.inputPerMillion) / 1_000_000 +
    (outputTokens * p.outputPerMillion) / 1_000_000
  );
}
