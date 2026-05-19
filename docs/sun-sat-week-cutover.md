# Sun→Sat payroll-week cutover

## Background

The KFI Driver OT Worksheet originally anchored payroll weeks on **Monday
through Sunday**. KFI actually runs payroll **Sunday through Saturday**, so
every helper, frontend default, OpenAPI description, and AI-extract prompt
was changed to snap weeks to Sunday. Schema is unchanged — `weeks.start_date`
just now stores a Sunday instead of a Monday.

For dev and test environments, `lib/db/src/preMigrate.ts` ships a one-shot
fixup (`sun_sat_week_cutover_2026`, gated by `schema_fixup_markers`) that
deletes every legacy Mon-anchored week row plus any bogus far-future rows
(the dev DB had stray 2031-dated weeks polluting the dropdown) and cascades
the delete through `punches`, `reviewed_drivers`, `customer_upload_attempts`,
`punch_deletions`, and the optional
`connecteam_daily_snapshots` / `driver_notes` / `driver_week_audit_log`
tables. It runs automatically via `pnpm --filter @workspace/db run push`.

## Production cutover

**Do not run the preMigrate fixup against production from the codebase.**
Production already has real Mon-anchored weeks that the dispatcher will want
to keep around for audit. Coordinate the wipe with the payroll team and
run the SQL below manually during a maintenance window, after a fresh
database backup.

```sql
BEGIN;

-- Sanity check: list every week that will be wiped.
SELECT start_date, end_date
FROM weeks
WHERE EXTRACT(DOW FROM start_date) <> 0   -- not a Sunday
   OR start_date > DATE '2027-01-01'      -- bogus far-future rows
ORDER BY start_date;

-- If the list looks right, run the cascade. The order matters because of
-- the FK relationships; punches and reviewed_drivers reference weeks.
WITH bad AS (
  SELECT start_date::text AS ws
  FROM weeks
  WHERE EXTRACT(DOW FROM start_date) <> 0
     OR start_date > DATE '2027-01-01'
)
DELETE FROM punches                  WHERE week_start::text IN (SELECT ws FROM bad);

WITH bad AS (
  SELECT start_date::text AS ws
  FROM weeks
  WHERE EXTRACT(DOW FROM start_date) <> 0
     OR start_date > DATE '2027-01-01'
)
DELETE FROM reviewed_drivers         WHERE week_start::text IN (SELECT ws FROM bad);

WITH bad AS (
  SELECT start_date::text AS ws
  FROM weeks
  WHERE EXTRACT(DOW FROM start_date) <> 0
     OR start_date > DATE '2027-01-01'
)
DELETE FROM customer_upload_attempts WHERE week_start::text IN (SELECT ws FROM bad);

WITH bad AS (
  SELECT start_date::text AS ws
  FROM weeks
  WHERE EXTRACT(DOW FROM start_date) <> 0
     OR start_date > DATE '2027-01-01'
)
DELETE FROM punch_deletions          WHERE week_start::text IN (SELECT ws FROM bad);

WITH bad AS (
  SELECT start_date::text AS ws
  FROM weeks
  WHERE EXTRACT(DOW FROM start_date) <> 0
     OR start_date > DATE '2027-01-01'
)

-- Optional / may not exist in every environment — skip silently if missing.
-- DELETE FROM driver_notes          WHERE week_start::text IN (SELECT ws FROM bad);
-- DELETE FROM driver_week_audit_log WHERE week_start::text IN (SELECT ws FROM bad);

DELETE FROM weeks
WHERE EXTRACT(DOW FROM start_date) <> 0
   OR start_date > DATE '2027-01-01';

-- Mark the cutover applied so a later `pnpm db push` against this DB
-- does not try to repeat it.
CREATE TABLE IF NOT EXISTS schema_fixup_markers (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_fixup_markers (name)
VALUES ('sun_sat_week_cutover_2026')
ON CONFLICT (name) DO NOTHING;

COMMIT;
```

## Backout

If something goes wrong, restore the pre-cutover database backup. The wipe
is destructive — there is no in-DB undo because the deletes cascade.

## Post-cutover sanity checks

```sql
-- Every remaining week should start on a Sunday.
SELECT start_date, EXTRACT(DOW FROM start_date) AS dow FROM weeks
WHERE EXTRACT(DOW FROM start_date) <> 0;
-- Expected: 0 rows.

-- No more bogus far-future weeks.
SELECT start_date FROM weeks WHERE start_date > DATE '2027-01-01';
-- Expected: 0 rows.

-- Marker row exists.
SELECT * FROM schema_fixup_markers WHERE name = 'sun_sat_week_cutover_2026';
-- Expected: 1 row.
```
