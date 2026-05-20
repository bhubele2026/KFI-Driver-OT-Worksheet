# AI extraction & per-row upload pipeline

This doc covers how customer-file uploads route between the deterministic parsers,
the learned-schema cache, and AI extraction.

## AI provider abstraction (Task #293)

The AI extractor talks to providers through a tiny `ModelClient` interface in
`lib/parsers/modelClient.ts`. The primary provider is **Claude Sonnet** (via
the user's own Anthropic API key) controlled by `AI_EXTRACT_PROVIDER`
(default `claude`) and `CLAUDE_EXTRACT_MODEL` (default `claude-sonnet-4-5`).
Gemini stays wired up as a quiet fallback: when the primary fails after
retries on a transient error (429 / 503 / 5xx / network) and the other
provider's credentials are configured, one secondary attempt runs before
the error bubbles to the dispatcher.

Every model call goes through `withModelRetry` — up to 3 attempts with
jittered exponential backoff starting at 1.5s and capped at 8s on transient
failures only; 4xx and schema errors fail fast. This is the guardrail that
turned the demo-night Adient 429 RATELIMIT_EXCEEDED from a hard
"upload failed" into a quiet ~3s pause and success.

Chunked spreadsheet extraction uses a bounded worker pool
(`XLSX_CHUNK_CONCURRENCY`, currently 3 — see Task #296) plus the shared
`runWithConcurrency` helper. The chunking math, the schema cache, the
OCR fallback for scanned DeLallo PDFs, and AI-sample retention are all
unchanged from before the Claude swap. Per-chunk recovery now uses
NDJSON row-tag re-issue instead of the legacy chunk-halving — see
[NDJSON output with `[R<n>]` row tags](#ndjson-output-with-rn-row-tags-task-308)
below.

### NDJSON output with `[R<n>]` row tags (Task #308)

The chunked-extract pipeline asks both Claude and Gemini for
newline-delimited JSON (one `{...}` object per line) instead of a
single `{ "rows": [...] }` blob. Each input row in the per-chunk body
is prefixed with a synthetic `[R<n>]` tag (1-indexed within the chunk)
and the model is instructed to echo that number as a `_row` field on
every output line — data and `{"_row":N,"_skip":true}` skip lines
alike. `parseNdjson` in `lib/parsers/aiExtract.ts` walks the response
line by line, tolerates stray ``` fence markers and blank lines, and
returns `{ rows, emittedRowIds, nonBlankLines, parseFailedLines }`.

After the first call, the runner diffs the assigned row IDs against
`emittedRowIds`. If any are missing (the classic
`maxOutputTokens`-mid-stream cut-off shows up as exactly this), it
re-issues a second model call carrying ONLY the missing rows
(`chunk_reissue` purpose on the `IngestionBudget`) and merges the
recovered objects with the originals. If the re-issue still misses
any IDs, the runner throws the same "split the spreadsheet into two
smaller files" error the old double-truncate path used — there's no
silent-partial state to surface, so the deprecated `extractionTruncated`
/ `failedChunks` fields on the preview payload are hardcoded to
`false` / `0` (kept on the OpenAPI contract for one release to avoid
a coordinated UI bump).

Per-chunk telemetry: when `nonBlankLines !== assignedIds.length` the
runner emits a `warn` with `{ chunkIdx, expected, emitted, missing,
parseFailedLines }` so a model that quietly drops or invents lines is
visible in the logs without waiting for the missing-IDs diff to fire.

## Uniform per-row upload pipeline (Task #250)

Every per-row upload (drag-drop or per-row picker, all customers, every format)
starts with the same single lookup against `customer_column_schemas` (keyed on
`(lower(customer), header_signature)`). Three possible outcomes per request:

1. **legacy-parser**: a `(customer, '*')` sentinel — seeded at boot from
   `LEGACY_PARSER_SEEDS` in `lib/parsers/parserDispatch.ts` — delegates to the
   existing hand-written parser via `dispatchLegacyParser(parserName, …)`.
2. **cache**: an exact header-signature match holds AI-discovered column roles
   (future — wiring for the generic role-based reader is staged but not yet
   emitting roles on AI runs).
3. **ai**: cache miss falls through to Gemini extraction.

When the legacy parser throws *or* returns 0 rows, the same handler kicks the
file straight to AI inline (no second round-trip), which is what kills the
previous "deterministic first, then 90s timeout" asymmetry that froze the
Trienda upload.

After a successful AI run on an xlsx, `recordAiSchemaIfPossible` (in
`lib/parsers/aiSchemaRecorder.ts`) locates the first AI punch's
badge/date/timeIn/timeOut inside the workbook to infer `columnRoles` (e.g.
`{badge:1,date:2,timeIn:3,timeOut:4}`) and upserts a
`(customer, headerSignature, 'xlsx')` cache row. The *next* upload with the
same header layout takes the `cache` branch and runs `readWithRoles` (in
`lib/parsers/genericRoleReader.ts`) — a generic xlsx role reader — instead of
Gemini, turning a 30-90s AI call into a sub-100ms deterministic parse.

Stale cache rows are self-healing: if the reader throws or returns 0 punches
the route falls through to AI, which then overwrites the cache row.

The preview payload returns `extractSource: 'legacy-parser' | 'cache' | 'ai'`
and the dialog renders a neutral source chip ("Built-in parser" / "Learned
schema" / "AI · review every row before confirming") in place of the prior
amber AI-fallback banner. xlsx header signature is a SHA-256 of the normalized
first non-empty row; PDFs/images skip the signature step and lookup only the
legacy sentinel (PDF caching is intentional follow-up).

The round-trip is pinned by
`lib/parsers/__tests__/schemaCacheRoundtrip.test.ts` (hermetic, no DB / no
Gemini). The bulk filename-routed `/upload-customer-file` path is unchanged.

## Reliable AI extraction on large files (Task #255)

The per-format AI ceiling is 90s for images (dispatcher is actively watching a
photo) and 300s for xlsx/PDF. xlsx whose serialized CSV exceeds 300k chars is
split into row-range chunks (each carrying the sheet header) and dispatched to
the model one at a time, then merged in document order — so an oversized
first-time upload reliably succeeds and warms the column-roles cache
(Task #250) for sub-100ms subsequent uploads.

`/extract-customer-file` returns `cacheWritten: true` when the AI run
successfully populated `customer_column_schemas`; the preview dialog renders a
green "Next upload of this format will be instant" chip, and the upload row
spinner adds a "first-time AI read can take a few minutes" hint past 15s.

### Survive tier-1 Anthropic rate limits on first-time uploads (Task #296)

The Anthropic tier-1 key is capped at **30,000 input tokens/min** on Claude
Sonnet 4.5. A first-time Adient upload (~71 chunks, ~355k aggregate input
tokens) used to spend its entire budget thrashing on 429 retries before the
`IngestionBudget` tripped. Four pieces work together to keep that upload on
Claude (switching to Gemini mid-extract was rejected as too risky — the model
produces different row shapes on the same file):

1. **Prompt caching.** The chunked-extract `buildParts` splits the prompt into
   a cacheable prefix (rules + roster + schema example) and a per-chunk text
   body. Cacheable text parts are marked `cacheable: true` in
   `ContentPart`; `claude.ts#toClaudeContent` translates that into
   `cache_control: { type: "ephemeral" }`. Chunk 1 of an upload pays
   `cache_creation` once; chunks 2..N hit `cache_read` at ~10% the input price
   AND those cached tokens no longer count against the per-minute window.
2. **`retry-after`-aware backoff.** `parseRetryAfterMs` reads both the standard
   `retry-after` header and Anthropic's
   `anthropic-ratelimit-input-tokens-reset` header (ISO timestamp or seconds).
   `withModelRetry` sleeps that long (capped at 70s) instead of its generic
   1.5s→8s exponential backoff, so a chunk that hits the window pauses until
   the window actually rolls.
3. **Token-bucket pacer.** `LeakyBucketPacer` (25,000 tokens / 60s for Claude,
   no-op for Gemini) is acquired with the per-chunk estimated input tokens
   before every `c.generate(…)`. Oversize requests block until enough capacity
   has freed up. The 25k cap is deliberately below the 30k ceiling so a
   single estimation slip doesn't trip 429.
4. **Lower concurrency + larger chunks.** `XLSX_CHUNK_CONCURRENCY` dropped 6→3
   and `XLSX_CHUNK_MAX_ROWS` bumped 60→120. Fewer chunks * lower fan-out keeps
   the in-window total under the pacer's cap even when chunk 1 is still
   paying full `cache_creation` cost.

### Progress reporting (Task #296)

Long extracts no longer leave the dispatcher staring at a frozen spinner.
The browser mints an opaque `progressKey` (UUID), sends it in the
`extract-customer-file` multipart body, and polls
`GET /weeks/:weekStart/extract-progress/:progressKey` once a second. The
chunked extractor publishes `{ current, total }` snapshots into the
in-process `extractProgress` tracker after every completed chunk; the
endpoint returns the latest snapshot (200) or 204 when the key is
unknown (key not seen yet, single-chunk file, cache-hit fast path, or
expired). The customer-upload row badge renders `Chunk N of M` next to
the existing elapsed-seconds counter as soon as the first tick arrives.

## OCR fallback for scanned PDFs

DeLallo PDFs that come from a scanner (no text layer) automatically fall back
to OCR via Gemini (`@google/genai`, `gemini-2.5-flash`) using the Replit AI
Integrations proxy. The fallback only fires when pdfjs extracts zero text, so
digital PDFs stay on the fast path. Env vars `AI_INTEGRATIONS_GEMINI_BASE_URL`
and `AI_INTEGRATIONS_GEMINI_API_KEY` are auto-provisioned.

## AI sample retention

Every AI extract stashes the original file in `ai_extract_samples` (bytea +
TTL). `/extract-new-customer` returns a `sampleId`; `/confirm-new-customer`
flips `confirmed_at = now()` and bumps retention to 90 days (unconfirmed
samples expire after 24h via `aiExtractSampleCleanup` hourly purge).

Admins can list and download samples via `GET /admin/ai-extract-samples` and
`GET /admin/ai-extract-samples/:id/download` to use as fixtures when promoting
an AI-imported customer to a real parser — see
[`promote-ai-customer-to-parser.md`](./promote-ai-customer-to-parser.md). The
bytea-in-Postgres approach (vs Replit App Storage) was a deliberate choice:
payroll exports are small (<25MB), retention is short, and it keeps the
deployment infra unchanged.

## Spend safety net (Task #297)

Every AI-powered customer-file upload runs inside an `IngestionBudget`
(`lib/parsers/ingestionBudget.ts`) that hard-caps spend per upload:

| Constant | Value | Behavior on hit |
| --- | --- | --- |
| `MAX_CALLS_PER_UPLOAD` | 30 | Throw `IngestionBudgetExceeded`; route returns HTTP 400. |
| `MAX_TOKENS_PER_UPLOAD` | 400_000 (input + output) | Same. |
| `SOFT_WARN_CALLS` | 20 | Single `warn` log (`warnedHot=true`) then continue. |

Each model invocation (chunk, chunk_retry, chunk_reissue, gemini_fallback,
single_call) calls `budget.recordCall(usage, purpose)` immediately after
the response so the ceiling can trip mid-upload — the existing 763-row
TriEnda incident burned ~1M tokens / ~$3 with no ceiling at all.

The `ModelClient` interface now returns `{ text, usage }` where `usage`
comes from `stream.finalMessage().usage` (Claude) or
`response.usageMetadata` (Gemini). Cost is converted via
`lib/parsers/pricing.ts` (Sonnet 4.5 + Gemini 2.5 Flash $/1M-token
rates) into a per-call USD figure rolled up into the budget summary.

A `ingest_done` info log is emitted at the end of every `aiExtractRows`
run with `{ totalCalls, totalInputTokens, totalOutputTokens,
totalCostUsd, byPurpose, byProvider, geminiFallbackUsed, warnedHot,
wallTimeMs }`. The same summary is persisted to `ingestion_runs`
(success / `budget_exceeded` / `extraction_failed`) and surfaced at
`GET /admin/ingestion-runs` for retroactive cost auditing.

**Gemini fallback is now opt-in per customer.** `customers.allowGeminiFallback`
defaults to `false`; flipping it on (via `/admin/customers`) lets the
cross-provider fallback fire when Claude is unreachable after retries.
A one-shot `?allowGeminiFallback=1` query param on the extract route is
the admin escape hatch for a single upload. When the fallback actually
fires the response carries `geminiFallbackUsed: true` and both customer
preview dialogs render an amber "Gemini fallback used" banner so the
dispatcher knows the rows came from the secondary model and should be
double-checked before confirming.

A chunk-payload assertion guards against the prompt-bloat shape of the
TriEnda incident: if a chunk's serialized prompt exceeds
`assignedRowCount * 500` chars, we log + throw before the model call so
the budget never gets a chance to drain on a single oversized request.
