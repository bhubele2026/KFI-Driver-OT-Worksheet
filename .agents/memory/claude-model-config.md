---
name: Claude model config & pricing
description: How per-feature Claude models are selected, and the pricing-row coupling that keeps cost tracking honest.
---

# Per-feature Claude model selection

Each Claude-backed feature picks its own model via its own env override, defaulting
to a constant in `artifacts/api-server/src/lib/parsers/claude.ts`:

- Extractor → `CLAUDE_EXTRACT_MODEL` ?? `DEFAULT_CLAUDE_MODEL` (Sonnet).
- Chat → `CLAUDE_CHAT_MODEL` ?? `DEFAULT_CLAUDE_MODEL` (Sonnet).
- Upload reviewer → `CLAUDE_ANALYSIS_MODEL` ?? `DEFAULT_CLAUDE_ANALYSIS_MODEL` (Opus).

**Rule:** when you point any of these at a new model string, add a matching row to
`PRICING` in `artifacts/api-server/src/lib/parsers/pricing.ts`. `costUsd()` is what
gets persisted (e.g. `upload_analysis_verdicts.costUsd`, `ingestion_runs`); an
unlisted model silently falls back to `FALLBACK_PRICING`.

**Why:** the reviewer/extractor record real-dollar cost per run. A missing pricing
row means the recorded cost is wrong, not an error. `FALLBACK_PRICING` is
intentionally the *most expensive* known Claude row (Opus) so an unrecognized model
over-estimates rather than under-bills — keep that invariant if you edit the table.

**How to apply:** changing a model default or adding an env override → also touch
`pricing.ts` and the optional-env list in `replit.md` in the same change.
