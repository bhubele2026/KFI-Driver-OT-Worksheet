# CLAUDE.md

Working notes for this repo live in [`replit.md`](replit.md); subsystem docs are in
[`docs/`](docs/) (extraction, Zenople export, auth, week cutover).

**Integration contract: `~/projects/KFI-Financial-Dashboard/INTEGRATION.md`.** KFI Payroll
Processing owns Connecteam and the Zenople punch *export*. Reporting data belongs in the
warehouse — this app does not yet read it (`WAREHOUSE_DATABASE_URL` unset), which is
recorded as debt there. Read the contract before adding any integration or credential.

## Zenople: the shared client

⚠️ **Never write Zenople HTTP by hand, and never edit the vendored client.**
`artifacts/api-server/src/lib/zenopleClient.ts` is a VENDORED copy of `@kfi/zenople` (canonical source:
`~/projects/KFI-Financial-Dashboard/packages/zenople/src/client.ts`), stamped with
its own hash; `pnpm check:zenople` fails the gate if a copy is edited locally.
To change it: edit the canonical file, then
`pnpm --filter @kfi/zenople sync` from the dashboard repo.

The client owns the vendor's API best practices — queue + bounded concurrency,
55/min + 900/hr limiter, exponential backoff honoring `Retry-After`, coalescing
of identical in-flight requests, a same-payload cooldown, TTL memo, timeouts, and
`pullRange()` for sequential date chunking. Rate discipline is not this app's
concern; if a rule needs changing, change it in the canonical file.

⚠️ **Any path that turns Zenople data into a QuickBooks entry passes
`{ force: true }`** so it never posts from a memoised read. `force` skips the
TTL memo but NOT the ~10s same-payload cooldown the vendor enforces anyway.

Full notes: `~/projects/KFI-Housing/docs/zenople-api.md` (Rate discipline section)
and `~/projects/KFI-Financial-Dashboard/INTEGRATION.md` rule 3.
