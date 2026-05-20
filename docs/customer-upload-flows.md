# Customer-file upload flows

This doc covers the customer-files panel, per-row interactions, alias machinery,
inactive customers, and parser-promotion suggestions. For the AI extraction and
schema-cache pipeline see [`ai-extraction.md`](./ai-extraction.md).

## Filename routing & multipart

Customer-file uploads are routed by filename keyword (`adient`, `iwg`,
`delallo`, `penda`, `trienda`, `greystone`, `lsi`, `burnett`, `zenople`).
Adient has *both* a PDF parser (legacy digital export) and an XLSX parser
(current Kronos pivot export); routing picks by extension.

Customer file upload is multipart and intentionally not in the OpenAPI body
schema; the frontend posts FormData directly to
`/api/weeks/:weekStart/upload-customer-file`. The "New customer file…" flow
follows the same pattern (`/extract-new-customer`, multipart) but persists
nothing until the dispatcher confirms via `/confirm-new-customer` (JSON).

## Customer-files panel & promotion suggestions

The week dashboard's customer-files panel is driven by `KNOWN_CUSTOMERS` (in
`lib/parsers/customers.ts`) joined with per-week aggregates from
`GET /weeks/:weekStart/customer-uploads`. Re-upload posts to the existing
parser route; new/unknown customers go through Gemini extraction + fuzzy
driver-name matching (`lib/parsers/{aiExtract,fuzzy}.ts`).

The panel also surfaces AI-only customers (those without a deterministic
parser) with an amber `AI · N weeks` badge driven by `aiImportWeekCount`
(count distinct weeks where `customer_upload_attempts.last_source = 'ai'`).
The same response also returns `aliasCount` (rows in `customer_name_aliases`
for that customer). Promotion guidance lives in
[`promote-ai-customer-to-parser.md`](./promote-ai-customer-to-parser.md).

## Driver-ID aliases

Customer payroll IDs (TELD codes, badge #s, employee numbers) are mapped to
KFI drivers via two layers: the static `EMBEDDED_MAPPING` in `lib/mappings.ts`
plus admin-managed rows in `driver_id_aliases`. The upload route loads aliases
on every request via `loadMergedIdMap()` and passes the merged map into
`detectAndParseFile`; DB rows win, so admins can also override stale embedded
entries.

CRUD lives at admin-only `GET/POST /driver-id-aliases` and
`PATCH/DELETE /driver-id-aliases/:externalId`. Admin UI at
`/admin/driver-id-aliases`; the "Unknown badges" warning on the
customer-files panel renders each id as a deep-link to that page with the
offending id pre-filled.

## Driver-name aliases (new-customer flow)

The new-customer flow remembers per-customer driver-name decisions in
`customer_name_aliases` (case-insensitive on `(customer, name_on_doc)`).
`confirm-new-customer` upserts an alias for every non-null mapping (Skip
leaves prior aliases intact); `extract-new-customer` consults the table and
returns `savedKfiId` per suggestion so the dispatcher's dropdown is
pre-filled. `DELETE /customer-aliases?customer=&nameOnDoc=` lets the
dispatcher forget a saved decision from inline in the dialog.

Admins can audit / re-map / forget every saved alias from
`/admin/customer-aliases`, backed by admin-only `GET` and
`PATCH /customer-aliases` (the GET payload bundles the active driver roster
so the re-map dropdown doesn't need a separate request).

## Per-row uploads onto AI-only customers

Per-row uploads onto AI-only customer rows (e.g. Schuette Metals photos) use
the same picker → `customer_name_aliases` machinery as the new-customer flow.
When the AI extractor reads rows but can't resolve any to a kfiId,
`/extract-customer-file` no longer 400s — it returns a preview-dialog payload
with empty `rows` and the unmapped name rows in `unmappedIds` (each id
encoded as `name:<DriverNameOnDoc>`).

The dispatcher maps each one in the picker; `/confirm-customer-file`
partitions picks by `name:` prefix — name picks write
`customer_name_aliases (customer, nameOnDoc, kfiId)`, badge picks still write
`driver_id_aliases`. Unresolved rows that the dispatcher just mapped are
re-resolved inside the same tx (from `ai_extract_samples.pending_named_rows`
jsonb) and appended to the import — so the picker actually drives punches
into the week, and the saved aliases auto-resolve next week's photo without
re-prompting.

The customer-preview-dialog's Confirm button is enabled whenever picks would
import rows (not just when explicit `rows[]` survive), and "Parser read N
rows" copy now correctly says "AI read N rows" on the AI-upfront / AI-fallback
paths. The `aiExtract.ts` test seam (`__pushAiExtractStub` /
`__clearAiExtractStubs`, dev-only) lets `imageSupport.test.ts` exercise the
resolve/pending split without invoking Gemini.

## Per-row drag-and-drop

The customer-files panel also supports per-row drag-and-drop: dropping a
single file onto a specific row bypasses filename-based routing entirely and
forces the file through `extractFor(customer, file)` for that row's customer.
The whole-panel drop overlay is suppressed while a row is the active drop
target (`rowDragCustomer` state). Multi-file or unsupported-extension drops
on a row are rejected with a toast (multi-file drops are explicitly steered
toward the panel-wide bulk zone). Browser-level dependency on
`stopPropagation` in the row drag handlers keeps the bulk zone from also
firing.

## Inactive customers

Customers can be marked inactive without losing history. The customer-files
panel row has an admin-only `⋯` menu with "Mark inactive"; admins manage the
full list at `/admin/inactive-customers` (linked from the admin nav).

Inactive state lives in `customer_active_state` (one row per inactive
customer, unique on lower(customer)) and every upload route
(`/upload-customer-file`, `/extract-customer-file`, `/extract-new-customer`,
`/confirm-new-customer`) rejects an inactive customer with a 400 +
"reactivate to upload" message. `GET /weeks/:weekStart/customer-uploads`
filters inactive customers out of both the KNOWN_CUSTOMERS rows and the
AI-only rows. Both transitions write a `user_audit_log` row
(`customer-inactive` / `customer-reactivate`) in the same transaction as the
state change. Routes: admin-only `GET / POST / DELETE
/customer-active-state` (DELETE takes `?customer=`).
