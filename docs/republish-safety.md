# Republish safety (Task #402)

Twice now, republishing the production app has been blamed for losing time
data on the dashboard. This doc nails down exactly what runs on a republish,
what does *not*, and the safeguards that now sit in front of the boot-time
routines.

## What republish does (and does not) do

The autoscale deploy `postBuild` step only runs `pnpm store prune`. It does
**not** run `pnpm db push`, drizzle-kit, or any migration. The only schema
mutations that ever touch production are the marker-gated fixups in
`lib/db/src/preMigrate.ts`, and those are explicitly run by an operator
(never on republish).

So the only writes a republish can plausibly cause come from the API
server's own boot sequence in `artifacts/api-server/src/index.ts`.

## Boot-time write paths (audited)

Each of the routines below now writes one row to `data_mutation_audit`
per invocation — including a `noop` row when nothing changed — so a clean
republish is auditable at a glance via `/admin/boot-audit`.

| Routine | Tables it can write | When |
| --- | --- | --- |
| `repairBogusObjectCustomers` | `drivers.customer` | Only rewrites rows whose current `customer` is the literal `"[object Object]"` or `null`, AND only when a *real* fresh value is available (non-empty, non-`Unknown`). Drivers no longer in Connecteam are **skipped with a warning** — never silently rewritten to `"Unknown"`. |
| `deleteLegacyParserSchemaRows` | `customer_column_schemas` (DELETE) | Routed through `safeBulkDelete` (threshold 50). In production a delete that would touch more than the threshold refuses unless `KFI_ALLOW_BULK_PUNCH_DELETE=1` is set; the refusal is recorded as `refused` in `data_mutation_audit`. |
| `seedDriverPayrollProfiles` | `driver_payroll_profiles` (UPSERT, additive) | Wrapped in `recordMutation` so any write — including no-ops — is audited. Never deletes. |
| Postgres rate-limit cleanup (`pgRateLimit.cleanup`) | `rate_limit_buckets` (DELETE of expired buckets only) | Periodic background sweep, not a boot-time mutation; not audited (does not touch dispatcher data). |
| Hidden-notes digest scheduler | none (mail surface is a no-op) | Scheduled task; sends no email and writes no data. |
| Realtime heartbeat | none | In-memory only. |

## Pre-migrate (`pnpm db push`) guard

`lib/db/src/preMigrate.ts` contains a handful of marker-gated one-shot
fixups that issue `DELETE FROM punches`. They are dev-DB tooling, but
the task spec explicitly calls out the risk of a confused operator (or
post-merge hook) running `pnpm db push` against the production DB — at
which point a fixup that has never run there would delete real punches.

`lib/db/src/preMigrateGuard.ts` is the structural fix. `main()` in
`preMigrate.ts` calls `evaluatePreMigrateGuard` before running any
fixup:

- In production (`NODE_ENV=production`), the run is **refused** when
  any of the names in `DESTRUCTIVE_PUNCH_FIXUPS` are scheduled,
  unless `KFI_ALLOW_BULK_PUNCH_DELETE=1` is set for the process.
- Every outcome (`ok`, `refused`, `error`) writes a row to
  `data_mutation_audit` keyed to `routine="preMigrate"` — the table
  is created on demand if it doesn't yet exist, so the audit row
  lands even on a brand-new DB.
- The refusal aborts `main()` before any DDL runs, so drizzle-kit
  push is never invoked either.

To intentionally run a destructive fixup against production, set
`KFI_ALLOW_BULK_PUNCH_DELETE=1` for that single invocation and unset
it immediately afterwards.

## Production bulk-delete guard

`artifacts/api-server/src/lib/safeBulkDelete.ts` is the single chokepoint
for any large `DELETE` that the server runs. It:

1. Counts the matching rows first (no-write probe).
2. In production, refuses the delete and writes a `refused` audit row
   when `matched > threshold` unless `KFI_ALLOW_BULK_PUNCH_DELETE=1`
   is set for the process. The threshold defaults to `5`.
3. Otherwise runs the delete and writes an `ok` (or `noop`) audit row
   with the actual `rowsAffected`.

To re-enable a known-safe bulk cleanup in production, set
`KFI_ALLOW_BULK_PUNCH_DELETE=1` for the deployment, run it, and unset it.
Never leave the variable on in production.

## How to investigate a suspected republish-caused mutation

1. Open `/admin/boot-audit`. Filter by `startedAt` around the republish.
2. A clean republish shows one `noop` row per routine above.
3. Any non-zero `rowsAffected`, `refused`, or `error` row is the smoking
   gun — the `routine`, `deploymentId`, `gitSha`, and `detail` columns
   identify the exact code path and deploy that produced it.

## How to add a new boot routine

- Wrap the body in `withMutationAudit("<routine name>", async (ctx) => {…})`
  from `artifacts/api-server/src/lib/dataMutationAudit.ts`, or call
  `recordMutation` directly. Always emit at least one row per boot, even
  when there's nothing to do.
- If the routine deletes rows in bulk, go through `safeBulkDelete` so the
  production guard applies.
- Add it to the table above so the safety model stays documented.
