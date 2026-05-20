# Architecture notes

Cross-cutting decisions that don't fit cleanly under auth or customer uploads.
For upload-pipeline details see [`customer-upload-flows.md`](./customer-upload-flows.md)
and [`ai-extraction.md`](./ai-extraction.md).

## Unified punches table

Single unified `punches` table with `source` (`Driver`/`Customer`) and
`isManual` flag. Connecteam refresh wipes `(week, source=Driver,
isManual=false)` then re-inserts; customer-file upload wipes
`(week, source=Customer, customer=X, isManual=false)` then re-inserts. Manual
punches are preserved across refreshes.

## Wall-clock times

Wall-clock times are stored as display-tz strings
(`"YYYY-MM-DD H:MM AM"`); arithmetic treats them as UTC for relative ordering,
which is correct because every comparison happens within a single driver's
display tz (`America/Chicago` by default, `America/New_York` for IWG drivers).

## Hours engine

Hours engine sorts all punches chronologically and splits the 40-hour boundary
mid-shift into RT vs OT, crediting each portion to the correct source.

`computeDriverTotals` returns both views of the same numbers:
- **Combined 40h split** — `regularHours` / `overtimeHours`. This is what
  payroll consumes (HTML/PDF timesheets in `lib/timesheets*.ts`, and the
  `routes/payroll.ts` export). Don't change these field names without a
  payroll-cutover plan.
- **Per-source breakdown** — `driverRt` / `driverOt` / `custRt` / `custOt`,
  the four buckets that satisfy `driverRt + driverOt = totalDriver`,
  `custRt + custOt = totalCustomer`, `driverRt + custRt = regularHours`,
  `driverOt + custOt = overtimeHours`. The on-screen driver-detail Summary
  card renders the per-source breakdown (Customer RT / Customer OT /
  Driver RT / Driver OT) so the two rolling-totals lines reconcile cleanly
  on the page; the Reconciliation checks panel cross-checks
  `custRt + driverRt = regularHours` and `custOt + driverOt = overtimeHours`
  so a future engine regression that breaks the four-bucket identity is
  caught.

## Zenople payroll export

The per-week Zenople export (`lib/zenopleExport.ts`) is built from each
driver's `driver_payroll_profiles` row plus their weekly punches.
Readiness blocks only on the **five identity fields** (`ssn`, `jobId`,
`personId`, `assignmentId`, `zenopleCustomer`) — those are the keys
that route the payroll line to the correct Zenople record. The eight
pay/bill rate fields are not checked: a missing rate is treated the
same as `$0` and written as numeric `0` in the workbook (the `rateFor`
helper coerces `null` → `0`). This avoids forcing admins to type
`0.00` into rate cells for drivers who legitimately have no
arrangement on a given bucket (no OT bill rate, salaried driver,
etc.). To re-enable strict rate validation, add the rate-field checks
back to `missingProfileFields`.

## Connecteam

All Connecteam API calls happen server-side (token never leaves the server);
the legacy proxy URL is gone.

## Rate limiter

`lib/rateLimit.ts` is backed by a `rate_limit_buckets` Postgres table so
counters survive restarts and are shared across API instances. The module
ships an in-memory backend (used by tests); `index.ts` swaps in
`createPostgresBackend(pool)` at startup and starts a periodic cleanup of
expired rows.
