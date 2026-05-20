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
`runWithConcurrency` helper. The chunking math, the schema cache, and
AI-sample retention are all unchanged from before the Claude swap.
Per-chunk recovery now uses
NDJSON row-tag re-issue instead of the legacy chunk-halving — see
[NDJSON output with `[R<n>]` row tags](#ndjson-output-with-rn-row-tags-task-308)
below.

### Per-chunk resume staging (Task #309)

Big first-contact xlsx uploads (10k+ rows, 70+ chunks) can take 10+
minutes. Before Task #309, a single failed chunk forced the dispatcher
to re-upload the file from scratch and pay Anthropic again for every
chunk that had already succeeded. The runner now checkpoints each
successful chunk to a staging table so a re-upload of the same bytes
skips Claude for every chunk already in hand.

How it works:

- `runChunkedXlsxExtract` accepts an optional `uploadKey` +
  `stageStore` (`AiExtractOptions`). The upload route in `weeks.ts`
  builds the key as `sha256(fileBytes):weekStart:lower(customer)` and
  passes the live DB-backed `dbChunkStageStore`. Single-call / image
  paths ignore both — there's nothing to checkpoint when there's only
  one Claude call.
- At the start of a chunked run, the runner loads every staged chunk
  for the key into an in-memory `Map<chunkIndex, rows>`. If non-empty,
  the api log shows `Resuming AI extract — skipped N of M chunks from
  staging`.
- For each chunk, the runner checks the map first. Hit → return the
  staged rows and tick progress without calling Claude. Miss → run the
  normal chunk pipeline (including the NDJSON re-issue retry); on
  clean completion, upsert the chunk's rows into `ai_extract_chunk_stage`.
- On full success of the whole upload, the runner deletes every staged
  row for that `uploadKey` in one statement. Failures to save / clear
  staging are logged and swallowed — they only cost the resume
  optimization, never the upload itself.

Schema (`lib/db/src/schema/aiExtractChunkStage.ts`):

- `(uploadKey text, chunkIndex int, chunkCount int, customer text,
  weekStart text, fileName text, assignedInputRowIds jsonb,
  extractedRows jsonb, createdAt, lastTouchedAt)` with a unique
  index on `(uploadKey, chunkIndex)`.

Operations:

- A boot-time cleanup interval (`startAiExtractChunkStageCleanup` in
  `lib/parsers/aiExtractStage.ts`) prunes rows whose `lastTouchedAt`
  is older than 7 days, every 6 hours.
- Admin endpoints (`requireAdmin`):
  - `GET /admin/extract-staging` — aggregated by `uploadKey`, one row
    per file-in-flight: `{ uploadKey, customer, weekStart, fileName,
    chunksStaged, chunkCount, createdAt, lastTouchedAt }`, ordered by
    `lastTouchedAt desc`, `?limit=` capped at 500 (default 50).
  - `DELETE /admin/extract-staging/:uploadKey` — discard every staged
    chunk for a key. Useful when an upload is genuinely abandoned and
    the operator doesn't want to wait for the 7-day pruner.

Limits:

- The key includes the full file hash, so two different files with
  the same name targeting the same (week, customer) never share
  staging. A second upload of the literal same bytes deliberately
  resumes — that's the point.
- The new-customer extract path (`/extract-new-customer-file`)
  participates in staging too; its `uploadKey` is computed off the
  post-image-normalize `extractBuffer` so a retry hits the same key.

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

## PDF routing by per-file text density (Task #349)

PDF uploads are routed by **per-file text density**, not by customer
name. `extractTextFromPdf` (pdfjs) runs on every PDF; if it returns
meaningful text (>50 non-whitespace chars), the document goes through
the generic PDF-text → AI extraction path (Lane B) alongside Adient,
IWG, and every other text-extractable PDF customer. If pdfjs extracts
no text (scanned image), the raw PDF bytes are sent to the model as
an `application/pdf` inline-data attachment for OCR (Lane C).

DeLallo used to have a customer-specific OCR fallback
(`ocrDelalloPDF`) hardcoded on the `customer === "delallo"` branch:
every DeLallo PDF — even fully digital ones with selectable text —
took the heavy vision path, and the separate code path silently
missed pipeline improvements (#306, #307, #339, pacer fixes). Task
\#349 removed that branch entirely and deleted `lib/parsers/ocr.ts`.
DeLallo is now "just another customer" and inherits every improvement
to the main pipeline; scanned weeks still produce rows via the generic
Lane C path.

### Stacked date/time cells (Task #375)

DeLallo's daily-punches PDF lays out each cell with the **date on the
top line and the clock time on the line directly below**, inside the
same visual box. Two complementary fixes keep that layout from
scrambling pairs through the AI extractor:

- **Lane B serializer.** `serializePdfTextItems` in
  `lib/parsers/aiExtract.ts` (exported for testing) detects when two
  adjacent y-bands are within `STACK_MAX_GAP` vertically AND ≥ 75% of
  the lower band's x positions column-align with the upper band's
  (within `STACKED_X_TOL`). When that holds, each upper item is paired
  with the nearest lower item by x and emitted as one logical line
  (`05/10 6:05AM 05/11 5:54AM …`) instead of two unrelated lines
  (`05/10 05/11 …` then `6:05AM 5:54AM …`). Flat single-baseline
  layouts (Adient/IWG/etc.) keep today's output byte-for-byte —
  the merge only fires when both checks pass.
- **Prompt hint.** The Claude and Gemini prompts both carry an
  explicit "stacked-cell" paragraph telling the model that some
  payroll PDFs stack date over time inside a single cell and to pair
  them column-wise instead of treating them as separate rows. Belt-
  and-suspenders for the Lane C / image paths where the serializer
  doesn't run (scanned PDFs and JPEG/HEIC photos go straight to the
  multimodal model with no text pre-pass).

Heuristic guard: the lower band needs ≥ 2 items (a single lower item
isn't enough column evidence) AND must be no wider than the upper
band, so a real header row above an independent data row never
accidentally absorbs the row below it.

Regression guard: `lib/parsers/__tests__/pdfSerializerStackedCells.test.ts`.

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
(`lib/parsers/ingestionBudget.ts`) that hard-caps spend per upload.
Two ceilings, two different jobs (Task #336):

| Ceiling | Value | Behavior on hit |
| --- | --- | --- |
| Per-upload call ceiling | **Dynamic** — `computeMaxCalls(plannedChunks) = (chunks × 2) + 10`, clamped to `[20, 200]` | Throw `IngestionBudgetExceeded`; route returns HTTP 400. |
| `MAX_TOKENS_PER_UPLOAD` | 400_000 (input + output) | Same. |
| Soft warn | `floor(maxCalls × SOFT_WARN_FRACTION)` where `SOFT_WARN_FRACTION = 0.66` | Single `warn` log (`warnedHot=true`) then continue. |

**Why a per-upload dynamic call ceiling.** The token ceiling is the
real spend guard — it never moves. The call count is a separate
"catch pathological retry-storm" proxy that has to bound files of
very different shapes: a 4-chunk Burnett and a 71-chunk
block-structured Adient can't share one static number. The xlsx
branch in `aiExtract.ts` calls `budget.setMaxCalls(computeMaxCalls(chunks.length))`
immediately after the chunker decides how to split the file:

- Tiny file (1 chunk) → clamped up to the **20-call floor**.
- Flat Penda-style upload (~20 chunks) → ~50 calls.
- Block-structured Adient (~71 chunks) → 152 calls.
- Pathological / buggy chunk plan → clamped down to the **200-call
  backstop** (`BACKSTOP_MAX_CALLS_PER_UPLOAD`) so an outright bug
  can't authorize unbounded model calls.

Non-xlsx paths (image, pdf, single-call) don't chunk by rows, so they
keep the constructor's default backstop — they never legitimately
need more than a handful of calls anyway.

The configured ceiling is surfaced on the budget summary as
`maxCalls`, written into the `ingest_done` log payload, and persisted
on `ingestion_runs.max_calls` so the admin audit feed
(`GET /admin/ingestion-runs`) shows each upload's actual call count
next to its configured ceiling. The soft warn payload also carries
the computed `softWarnAt` value so it's obvious from the log line
how hot "hot" was for that particular file shape.

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

## Recipe cache contract (Task #310)

The whole shape of the upload pipeline depends on a single promise: **the
first contact with a new customer's file format pays the AI cost, and
every subsequent same-format upload reuses a cached "recipe" (column
roles) and finishes in seconds with zero Claude calls.** This section
documents what's cached, what invalidates it, and how to inspect or
forcibly re-learn it.

### What's cached

One row per `(lower(customer), header_signature, format)` triple in
`customer_column_schemas`:

- `headerSignature` — SHA-256 of the normalized first non-empty row
  (xlsx) or normalized first-page line set (pdf), via
  `computeHeaderSignature` in `lib/parsers/schemaSignature.ts`.
- `format` — `'xlsx'` or `'pdf'`. Image uploads (`jpg`/`png`/`heic`)
  never produce a recipe — they have no stable signature.
- `source` — always `'ai'` for recipes written by this path. Legacy
  parser sentinel rows have `source='legacy'` and are out of scope.
- `columnRoles` — for xlsx, `{ badge, date, timeIn, timeOut, hours? }`
  column indices. For pdf, `{ employeeAnchor, dataRow }` regex
  templates with capture-group conventions documented in
  `aiSchemaRecorder.ts`.

### When it's written

After a successful AI extraction, `recordAiSchemaIfPossible` runs
`deriveSchemaCacheMutation` which inspects the first AI-emitted punch
and tries to locate its badge / date / timeIn / timeOut inside the
original buffer. Outcomes:

- **`upsert`** — a row carrying all four matching values was found in
  the workbook. Persist the column indices (xlsx) or derive a pair of
  regex templates (pdf), then upsert keyed on
  `(customer, header_signature, format)`.
- **`delete-stale`** — AI succeeded but the inferrer couldn't locate
  the sample. Any existing cache row under the same key is by
  definition stale (it just produced 0 rows for this upload), so wipe
  it. Next upload re-runs AI directly instead of paying the
  "cache → 0 → AI" tax every week.
- **`skip`** — image upload, empty AI result, unknown extension, or
  missing signature. No-op.

### What invalidates it

- The header changes (new column added, renamed, reordered) — the
  `header_signature` becomes a different key and a fresh AI run writes
  a new row. The old row stays put until manually deleted.
- The cached reader throws or returns 0 punches for a future upload
  with the same signature — the route falls through to AI which then
  re-derives roles and either overwrites the row (`upsert`) or wipes
  it (`delete-stale`).
- An admin deletes the row via `DELETE /admin/extract-recipes/:id`
  (below) to force a re-learn.

### Known limitation: block-structured xlsx

`inferColumnRoles` assumes a **flat** layout — one header row plus
per-punch data rows where each row carries badge + date + timeIn +
timeOut in its own cells. Block-structured workbooks like Adient's
(an "Employee Name" header row in one column band followed by date
rows in a different column band) currently fail inference and fall
into the `delete-stale` branch, so Adient pays the AI cost every
week. Tracked as a follow-up: extend inference to recognize
block-structured layouts and persist a structure descriptor alongside
the column roles. The flat-layout fixtures (Greystone, Trienda,
Penda, Burnett, LSI, Zenople) all cache successfully on first
contact.

### Telemetry

Every successful upload — both AI and cache-hit — emits an
`ingest_done` info log and persists one row to `ingestion_runs`. The
boolean `recipeCacheHit` field is `true` only on cache-hit short-
circuits (zero model calls, the deterministic `readWithRoles` /
`readPdfWithRoles` reader produced the punches). The hit rate is the
canonical "pay once" health metric:

```
SELECT
  date_trunc('day', created_at) AS day,
  SUM(CASE WHEN recipe_cache_hit THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN NOT recipe_cache_hit THEN 1 ELSE 0 END) AS ai_calls
FROM ingestion_runs
WHERE outcome = 'success'
GROUP BY 1 ORDER BY 1 DESC;
```

### Admin surface

- `GET /admin/extract-recipes?customer=<substr>&limit=<n>` — lists
  AI-discovered recipes (id, customer, headerSignature, format,
  columnRoles, createdAt), newest first. Read-only inspection for
  "is the pay-once promise holding for customer X?".
- `DELETE /admin/extract-recipes/:id` — wipes one recipe row. The
  next upload of that customer/format pays the AI cost again and
  writes a fresh recipe (or `delete-stale`s if the inferrer still
  can't learn it).

### Regression guard

`lib/parsers/__tests__/recipeCachePayOnce.test.ts` pins both halves
of the contract end-to-end against the `Greystone.xlsx` fixture:

1. First upload — push one AI stub, run `aiExtractRows`, assert
   `budgetSummary.totalCalls >= 1` AND
   `deriveSchemaCacheMutation` returns `action: 'upsert'` with
   roles.
2. Second upload — same bytes, **no stubs pushed**. Call
   `readWithRoles` with the recipe captured above. Assert the
   punches reproduce the first-upload row deterministically (zero
   model calls because the AI extractor isn't on the call path).

If the inferrer ever stops returning roles for the first-contact
sample, step 1 fails loudly with `action !== 'upsert'` and the team
knows the pay-once promise is broken before it ships.
