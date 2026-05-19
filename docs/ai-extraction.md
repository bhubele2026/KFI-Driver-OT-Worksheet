# AI extraction & per-row upload pipeline

This doc covers how customer-file uploads route between the deterministic parsers,
the learned-schema cache, and Gemini AI extraction.

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
Gemini one at a time with a 120s per-chunk ceiling, then merged in document
order — so an oversized first-time upload reliably succeeds and warms the
column-roles cache (Task #250) for sub-100ms subsequent uploads.

`/extract-customer-file` returns `cacheWritten: true` when the AI run
successfully populated `customer_column_schemas`; the preview dialog renders a
green "Next upload of this format will be instant" chip, and the upload row
spinner adds a "first-time AI read can take a few minutes" hint past 15s.

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
