import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set before running the pre-migrate fixups.",
  );
}

type Fixup = {
  name: string;
  describe: string;
  detect: string;
  apply: string;
};

const FIXUPS: Fixup[] = [
  {
    name: "customer_upload_attempts.last_unmapped_ids text[] -> jsonb",
    describe:
      "drizzle-kit push cannot auto-cast text[] to jsonb; convert in place.",
    detect: `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'customer_upload_attempts'
        AND column_name = 'last_unmapped_ids'
        AND data_type = 'ARRAY'
    `,
    apply: `
      ALTER TABLE customer_upload_attempts
      ALTER COLUMN last_unmapped_ids TYPE jsonb
      USING CASE
        WHEN last_unmapped_ids IS NULL THEN NULL
        ELSE to_jsonb(last_unmapped_ids)
      END
    `,
  },
  // ---------------------------------------------------------------------
  // Sun→Sat payroll-week cutover (May 2026).
  //
  // The app historically anchored weeks on Monday; KFI actually runs
  // payroll Sunday→Saturday. We wipe every legacy Mon-anchored week and
  // any bogus far-future rows (the dev DB had stray 2031-dated weeks
  // polluting the dropdown) and let the dispatcher start fresh from the
  // first real Sun→Sat week after the cutover.
  //
  // The marker table `schema_fixup_markers` gates this one-shot wipe so a
  // long-lived environment only runs it once. Safe to apply to dev DBs at
  // any time; for production, see docs/sun-sat-week-cutover.md — the
  // executor must not run this fixup against prod.
  {
    name: "wipe legacy Mon-anchored and >2027 week rows (Sun→Sat cutover)",
    describe:
      "Truncate week-scoped tables and delete weeks rows whose start is not a Sunday or is dated after 2027-01-01. One-shot, gated by schema_fixup_markers.",
    // Always run apply; the marker table is created on the first invocation
    // and the DO block self-guards via the marker row, so subsequent runs are
    // no-ops. Detect can't reference schema_fixup_markers directly because
    // Postgres parses the whole statement up-front.
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      DECLARE
        bad_weeks text[];
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'sun_sat_week_cutover_2026'
        ) THEN
          RETURN;
        END IF;
        SELECT COALESCE(array_agg(start_date::text), ARRAY[]::text[])
          INTO bad_weeks
          FROM weeks
          WHERE EXTRACT(DOW FROM start_date) <> 0
             OR start_date > DATE '2027-01-01';

        IF array_length(bad_weeks, 1) IS NOT NULL THEN
          DELETE FROM punches                    WHERE week_start::text = ANY(bad_weeks);
          DELETE FROM reviewed_drivers           WHERE week_start::text = ANY(bad_weeks);
          DELETE FROM customer_upload_attempts   WHERE week_start::text = ANY(bad_weeks);
          DELETE FROM punch_deletions            WHERE week_start::text = ANY(bad_weeks);
          -- parser_promotion_snoozes is keyed by customer, not week_start;
          -- nothing to clean there.
          -- These tables also key on week_start; safe to no-op if absent.
          BEGIN
            DELETE FROM connecteam_daily_snapshots WHERE week_start::text = ANY(bad_weeks);
          EXCEPTION WHEN undefined_table THEN NULL; END;
          BEGIN
            DELETE FROM driver_notes             WHERE week_start::text = ANY(bad_weeks);
          EXCEPTION WHEN undefined_table THEN NULL; END;
          BEGIN
            DELETE FROM driver_week_audit_log    WHERE week_start::text = ANY(bad_weeks);
          EXCEPTION WHEN undefined_table THEN NULL; END;
          DELETE FROM weeks WHERE start_date::text = ANY(bad_weeks);
        END IF;
      END$$;
      INSERT INTO schema_fixup_markers (name) VALUES ('sun_sat_week_cutover_2026')
        ON CONFLICT (name) DO NOTHING;
    `,
  },
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const fixup of FIXUPS) {
      const detected = await client.query(fixup.detect);
      if (detected.rowCount && detected.rowCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[pre-migrate] applying: ${fixup.name}`);
        await client.query(fixup.apply);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[pre-migrate] failed:", err);
  process.exit(1);
});
