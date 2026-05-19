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

## Connecteam

All Connecteam API calls happen server-side (token never leaves the server);
the legacy proxy URL is gone.

## Rate limiter

`lib/rateLimit.ts` is backed by a `rate_limit_buckets` Postgres table so
counters survive restarts and are shared across API instances. The module
ships an in-memory backend (used by tests); `index.ts` swaps in
`createPostgresBackend(pool)` at startup and starts a periodic cleanup of
expired rows.
