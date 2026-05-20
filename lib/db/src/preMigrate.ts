import pg from "pg";
import {
  evaluatePreMigrateGuard,
  recordPreMigrateAudit,
  PRE_MIGRATE_OPT_IN_ENV,
} from "./preMigrateGuard.js";

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
  // ---------------------------------------------------------------------
  // Task #287 — seed the new `customers` table from the legacy hardcoded
  // KNOWN_CUSTOMERS list, copy customer_active_state→customers.active,
  // backfill two production Connecteam user aliases that were previously
  // synthesized at runtime, set display_tz on the two East-Coast drivers
  // that were previously inferred from IWG_DRIVER_IDS, and wipe the
  // legacy driver_id_aliases table (which seeded itself from
  // EMBEDDED_MAPPING on every boot — no longer needed now that aliases
  // are admin-managed only).
  //
  // One-shot, gated by schema_fixup_markers. Idempotent: re-runs are
  // no-ops. The CREATE TABLE IF NOT EXISTS guard lets this run BEFORE
  // drizzle-kit push (which creates the canonical table), so the seed
  // can complete even on a brand-new database where push hasn't run
  // yet. drizzle-kit will then ALTER the table to match the canonical
  // shape on the next push without disturbing the seeded rows.
  {
    name: "seed customers table + bootstrap aliases/tz (Task #287)",
    describe:
      "One-shot seed of the customers table from the legacy KNOWN_CUSTOMERS array, copy of customer_active_state, two production ct user aliases, two driver display_tz overrides, and TRUNCATE of driver_id_aliases.",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'customers_seed_and_wipe_2026'
        ) THEN
          RETURN;
        END IF;

        -- Customers table may not exist yet on a fresh DB; create a
        -- minimal shape so the seed can populate it. drizzle-kit push
        -- will then ALTER it to match the canonical schema (adds the
        -- created_by/updated_by FKs, the unique index, etc).
        CREATE TABLE IF NOT EXISTS customers (
          id serial PRIMARY KEY,
          display_name text NOT NULL,
          filename_keywords text[] NOT NULL,
          extensions text[] NOT NULL,
          active boolean NOT NULL DEFAULT true,
          sort_order integer NOT NULL DEFAULT 1000,
          created_by integer,
          updated_by integer,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        -- Seed the 9 legacy KNOWN_CUSTOMERS in original order with
        -- sortOrder gaps of 10 so an admin can slot a new customer in
        -- between two existing rows without renumbering everything.
        INSERT INTO customers (display_name, filename_keywords, extensions, sort_order)
        VALUES
          ('Adient',                    ARRAY['adient'],         ARRAY['xlsx'],       10),
          ('IWG',                       ARRAY['iwg'],            ARRAY['pdf'],        20),
          ('DeLallo',                   ARRAY['delallo'],        ARRAY['pdf'],        30),
          ('Trienda',                   ARRAY['trienda'],        ARRAY['xlsx'],       40),
          ('Penda',                     ARRAY['penda'],          ARRAY['xlsx'],       50),
          ('Greystone',                 ARRAY['greystone'],      ARRAY['xlsx','pdf'], 60),
          ('LSI',                       ARRAY['lsi'],            ARRAY['xlsx','pdf'], 70),
          ('Burnett Dairy-Grantsburg',  ARRAY['burnett'],        ARRAY['xlsx','pdf'], 80),
          ('Zenople',                   ARRAY['zenople'],        ARRAY['xlsx','pdf'], 90)
        ON CONFLICT DO NOTHING;

        -- Copy customer_active_state → customers.active. Match
        -- case-insensitively on display_name; rows in the active-state
        -- table that don't correspond to a seeded customer get
        -- INSERTed as inactive entries so the per-week "hidden" panel
        -- keeps showing them.
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'customer_active_state'
        ) THEN
          -- customer_active_state stored only the inactive list (every
          -- row implied active=false). Mirror that into customers.active.
          UPDATE customers c
             SET active = false,
                 updated_at = s.inactive_at,
                 updated_by = s.inactive_by_user_id
            FROM customer_active_state s
           WHERE lower(c.display_name) = lower(s.customer);

          INSERT INTO customers (display_name, filename_keywords, extensions, active, sort_order, created_by, updated_by, created_at, updated_at)
          SELECT s.customer, ARRAY[]::text[], ARRAY[]::text[], false, 1000, s.inactive_by_user_id, s.inactive_by_user_id, s.inactive_at, s.inactive_at
            FROM customer_active_state s
           WHERE NOT EXISTS (
                   SELECT 1 FROM customers c
                    WHERE lower(c.display_name) = lower(s.customer)
                 );

          DROP TABLE customer_active_state;
        END IF;

        -- Two production Connecteam aliases that were previously
        -- synthesized from USER_ID_ALIASES_LD on every ingest. Insert
        -- only if the table exists (it may not yet on a fresh DB) and
        -- only if the target driver exists.
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'connecteam_user_aliases'
        ) THEN
          INSERT INTO connecteam_user_aliases (ct_user_id, kfi_id, note)
          SELECT 13213413, '2004805', 'Backfilled from legacy USER_ID_ALIASES_LD (Task #287)'
          WHERE EXISTS (SELECT 1 FROM drivers WHERE kfi_id = '2004805')
          ON CONFLICT DO NOTHING;
          INSERT INTO connecteam_user_aliases (ct_user_id, kfi_id, note)
          SELECT 13441325, '2004589', 'Backfilled from legacy USER_ID_ALIASES_LD (Task #287)'
          WHERE EXISTS (SELECT 1 FROM drivers WHERE kfi_id = '2004589')
          ON CONFLICT DO NOTHING;
        END IF;

        -- Two East-Coast IWG drivers previously inferred at runtime
        -- from IWG_DRIVER_IDS. Persist their display_tz so the
        -- hardcoded list can be removed.
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'drivers' AND column_name = 'display_tz'
        ) THEN
          UPDATE drivers
             SET display_tz = 'America/New_York'
           WHERE kfi_id IN ('2005056', '2005212')
             AND (display_tz IS NULL OR display_tz = '');
        END IF;

        -- driver_id_aliases used to be auto-seeded from EMBEDDED_MAPPING
        -- on every boot. The table now holds admin-managed entries only,
        -- so wipe the legacy seed once. Subsequent runs are no-ops.
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'driver_id_aliases'
        ) THEN
          TRUNCATE driver_id_aliases;
        END IF;

        INSERT INTO schema_fixup_markers (name) VALUES ('customers_seed_and_wipe_2026');
      END$$;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #288 — seed `clock_offsets` with the two legacy Shuster +1h fix
  // rows so existing Connecteam ingest keeps applying the same offset
  // after the hardcoded SHUSTER_CLOCK_IDS constant in `lib/mappings.ts`
  // is removed. One-shot, marker-gated. Safe to re-run; the marker
  // prevents reseeding a row that a dispatcher later deleted on purpose.
  // The CREATE TABLE IF NOT EXISTS guard lets the seed succeed even on a
  // fresh DB where drizzle-kit push hasn't run yet.
  {
    name: "seed clock_offsets with legacy Shuster +1h rows",
    describe:
      "Insert the two Shuster clock_ids (2005033 and 2004992) with +1.00h offsets. Marker-gated so deleting a row in the admin UI doesn't reintroduce it on the next deploy.",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'seed_clock_offsets_shuster_2026'
        ) THEN
          RETURN;
        END IF;
        -- Pre-migrate runs before drizzle-kit push, so on the first deploy
        -- the table may not exist yet. Create a minimal compatible shape so
        -- the seed INSERT succeeds; push will reconcile the rest of the
        -- schema (constraints, FKs, defaults) immediately afterward.
        CREATE TABLE IF NOT EXISTS clock_offsets (
          clock_id     text PRIMARY KEY,
          hours_offset numeric(6, 2) NOT NULL,
          note         text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now(),
          created_by   integer,
          updated_by   integer
        );
        INSERT INTO clock_offsets (clock_id, hours_offset, note)
        VALUES
          ('2005033', 1.00, 'Legacy Shuster +1h fix (seeded from SHUSTER_CLOCK_IDS).'),
          ('2004992', 1.00, 'Legacy Shuster +1h fix (seeded from SHUSTER_CLOCK_IDS).')
        ON CONFLICT (clock_id) DO NOTHING;
        INSERT INTO schema_fixup_markers (name)
          VALUES ('seed_clock_offsets_shuster_2026')
          ON CONFLICT (name) DO NOTHING;
      END$$;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #357 — seed the third Shuster clock (id 2005141) with the same
  // +1h offset as the other two. Shuster added a new Connecteam clock
  // and every fresh pull from it landed an hour off until this row
  // existed. Separate marker from the Task #288 seed so an env that
  // already ran the original two-row seed still picks this one up.
  // Idempotent + admin-deletable (the marker prevents reseeding a row
  // a dispatcher later deleted on purpose).
  {
    name: "seed clock_offsets with Shuster clock 2005141 (Task #357)",
    describe:
      "Insert Shuster clock_id 2005141 with +1.00h offset, mirroring the existing 2005033 / 2004992 seeds. Marker-gated.",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'seed_clock_offset_shuster_2005141_2026'
        ) THEN
          RETURN;
        END IF;
        CREATE TABLE IF NOT EXISTS clock_offsets (
          clock_id     text PRIMARY KEY,
          hours_offset numeric(6, 2) NOT NULL,
          note         text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now(),
          created_by   integer,
          updated_by   integer
        );
        INSERT INTO clock_offsets (clock_id, hours_offset, note)
        VALUES
          ('2005141', 1.00, 'Shuster +1h fix — third clock added May 2026 (Task #357).')
        ON CONFLICT (clock_id) DO NOTHING;
        INSERT INTO schema_fixup_markers (name)
          VALUES ('seed_clock_offset_shuster_2005141_2026')
          ON CONFLICT (name) DO NOTHING;
      END$$;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #301 — drop the orphaned parser_promotion_snoozes table. The
  // promotion-banner scaffolding it backed was removed once the legacy
  // hardcoded parsers were deleted (there's nothing left to "promote
  // an AI customer to"), so the table is dead weight. One-shot,
  // marker-gated; idempotent.
  {
    name: "drop parser_promotion_snoozes (Task #301)",
    describe:
      "Drop the parser_promotion_snoozes table after the promotion-banner scaffolding was removed.",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'drop_parser_promotion_snoozes_2026'
        ) THEN
          RETURN;
        END IF;
        DROP TABLE IF EXISTS parser_promotion_snoozes;
        INSERT INTO schema_fixup_markers (name)
          VALUES ('drop_parser_promotion_snoozes_2026')
          ON CONFLICT (name) DO NOTHING;
      END$$;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #336 — add a nullable `max_calls` integer column to
  // `ingestion_runs` to record the per-upload AI call ceiling the
  // budget was configured with. Idempotent: re-runs are no-ops once
  // the column exists. Marker is unnecessary because the CREATE
  // guard is already DDL-conditional.
  {
    name: "add ingestion_runs.max_calls (Task #336)",
    describe:
      "Add a nullable max_calls integer column to ingestion_runs so each row records the per-upload call ceiling next to its actual totalCalls.",
    detect: `SELECT 1`,
    apply: `
      ALTER TABLE IF EXISTS ingestion_runs
        ADD COLUMN IF NOT EXISTS max_calls integer;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #354 — reconcile the two customer roster rows whose display_name
  // never matched what Connecteam / Zenople / the AI extractor's learned
  // recipe (`customer_column_schemas`) actually use:
  //
  //   roster "Penda"    → canonical "Penda Corp"     (id=5)
  //   roster "Trienda"  → canonical "Trienda Holdings" (id=4)
  //
  // The mismatch silently routed every Penda upload into a bucket that
  // no driver belonged to, leaving the dispatcher's Penda card empty
  // and forcing Claude to re-learn the recipe on every upload. After
  // the rename, `customers.display_name = drivers.customer =
  // customer_column_schemas.customer`, the cached recipe is reused,
  // and the dashboard groups imported punches under the correct card.
  //
  // Keep both legacy and canonical names in `filename_keywords` so the
  // dispatcher's existing filename conventions still match. Only renames
  // when the legacy name is still present, so re-runs and a future admin
  // edit are both safe. Marker-gated; idempotent.
  {
    name: "rename Penda/Trienda roster to canonical names (Task #354)",
    describe:
      "Rename customers id=5 Penda → Penda Corp and id=4 Trienda → Trienda Holdings; extend filename_keywords to cover both names so existing uploads still match.",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'rename_penda_trienda_canonical_2026'
        ) THEN
          RETURN;
        END IF;

        -- Set-union the existing filename_keywords with the canonical
        -- name so any admin-added routing keywords survive the rename.
        UPDATE customers
           SET display_name = 'Penda Corp',
               filename_keywords = (
                 SELECT ARRAY(
                   SELECT DISTINCT k
                     FROM unnest(
                       coalesce(filename_keywords, ARRAY[]::text[])
                       || ARRAY['penda','penda corp']::text[]
                     ) AS k
                 )
               ),
               updated_at = now()
         WHERE display_name = 'Penda';

        UPDATE customers
           SET display_name = 'Trienda Holdings',
               filename_keywords = (
                 SELECT ARRAY(
                   SELECT DISTINCT k
                     FROM unnest(
                       coalesce(filename_keywords, ARRAY[]::text[])
                       || ARRAY['trienda','trienda holdings']::text[]
                     ) AS k
                 )
               ),
               updated_at = now()
         WHERE display_name = 'Trienda';

        INSERT INTO schema_fixup_markers (name)
          VALUES ('rename_penda_trienda_canonical_2026')
          ON CONFLICT (name) DO NOTHING;
      END$$;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #354 (Penda full reset) — one-shot Penda-only state wipe so the
  // next dispatcher upload re-learns the AI recipe from scratch through
  // Claude. The dispatcher's confidence in the cached recipe was broken
  // by today's e2e contamination episode (driver roster contained 78
  // stub rows when the recipe was first written), so we wipe and re-derive
  // even though the cached `customer_column_schemas` row (id=111) has the
  // same header_signature as the working Trienda cache.
  //
  // Scoped strictly to Penda. Other customers' caches are untouched.
  // Pre-deletion inventory snapshot is preserved at
  // .local/forensics/penda-prod-inventory-pre-wipe.txt for forensics.
  // Marker-gated so future Penda data the dispatcher creates after the
  // wipe will NOT be re-deleted on subsequent deploys.
  {
    name: "wipe Penda customer state for clean re-derivation (Task #354)",
    describe:
      "Delete Penda-only rows from customer_column_schemas, ai_extract_samples, customer_upload_attempts, and driver_id_aliases so the next upload re-runs through Claude. Marker-gated; runs once.",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'wipe_penda_state_2026'
        ) THEN
          RETURN;
        END IF;

        DELETE FROM customer_column_schemas
         WHERE customer IN ('Penda Corp', 'Penda');

        DELETE FROM ai_extract_samples
         WHERE customer IN ('Penda Corp', 'Penda');

        DELETE FROM customer_upload_attempts
         WHERE customer IN ('Penda Corp', 'Penda');

        BEGIN
          DELETE FROM driver_id_aliases
           WHERE customer IN ('Penda Corp', 'Penda');
        EXCEPTION WHEN undefined_table THEN NULL; END;

        INSERT INTO schema_fixup_markers (name)
          VALUES ('wipe_penda_state_2026')
          ON CONFLICT (name) DO NOTHING;
      END$$;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #354 (companion) — quarantine the e2e onboarding test data
  // that leaked into production today. Two synthetic customers
  // ("E2E Penda e2e-onb-pen-…", "E2E DeLallo e2e-onb-del-…") and ~78
  // stub drivers got written into prod when the self-onboarding-*.spec
  // suites pointed at the live DB.
  //
  // We do NOT delete: the dispatcher may want forensic visibility, and
  // the drivers table has no FK we'd be cleaning up. Instead:
  //   • flip e2e customer rows to active=false so they fall off the
  //     dispatcher's dashboard immediately
  //   • flip e2e stub driver rows to is_archived=true so they stop
  //     appearing in week views and roster pickers
  //
  // Pattern-matched (not id-pinned) so future leaks of the same shape
  // are also quarantined. Marker-gated; re-runs are no-ops because the
  // marker is inserted regardless of how many rows matched.
  //
  // Root cause (the test specs writing to prod) is filed as a separate
  // follow-up — this fixup only contains the bleed.
  {
    name: "quarantine e2e onboarding leakage (Task #354 companion)",
    describe:
      "Deactivate any customers/drivers rows whose names match the e2e onboarding fixture pattern (E2E …, e2e-onb-…, … Stub …).",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'quarantine_e2e_onboarding_leak_2026'
        ) THEN
          RETURN;
        END IF;

        UPDATE customers
           SET active = false,
               updated_at = now()
         WHERE active = true
           AND (
             display_name ILIKE 'E2E %'
             OR display_name ILIKE '%e2e-onb-%'
           );

        -- Only quarantine drivers whose row carries an unambiguous
        -- e2e token. The "Stub" branch is AND-gated against an e2e
        -- marker on either name or customer to avoid catching a
        -- legitimate driver whose surname happens to contain "Stub".
        BEGIN
          UPDATE drivers
             SET is_archived = true,
                 updated_at = now()
           WHERE is_archived = false
             AND (
               name ILIKE '%E2E %'
               OR name ILIKE '%e2e-onb-%'
               OR customer ILIKE 'E2E %'
               OR customer ILIKE '%e2e-onb-%'
               OR (
                 name ILIKE '%Stub%'
                 AND (name ILIKE '%e2e%' OR customer ILIKE '%e2e%')
               )
             );
        EXCEPTION WHEN undefined_column THEN NULL; END;

        INSERT INTO schema_fixup_markers (name)
          VALUES ('quarantine_e2e_onboarding_leak_2026')
          ON CONFLICT (name) DO NOTHING;
      END$$;
    `,
  },
  // ---------------------------------------------------------------------
  // Task #359 — purge the e2e onboarding stub rows that yesterday's
  // "flip flags" fixup left behind.
  //
  // The companion fixup above only set `customers.active=false` and
  // `drivers.is_archived=true`. That was not enough: the customer-file
  // extract path (`POST /extract-customer-file` and
  // `POST /confirm-customer-file` in `artifacts/api-server/src/routes/
  // weeks.ts`) was loading drivers via
  //   `db.select().from(schema.driversTable)`
  // with NO `is_archived = false` filter, so the badge-resolution map
  // built from that query happily resolved real customer badges
  // (Penda 2001117, 2001234, …) onto the archived stub driver rows.
  // A dispatcher who hit "Confirm import" before today's fix would
  // have written real payroll punches against fake drivers.
  //
  // Task #359 fixes both halves:
  //   1. Code: the two extract-path queries now filter on
  //      `isArchived = false` so a future archived stub can't be matched
  //      again even if the row itself escapes deletion.
  //   2. Data (this fixup): hard-delete every e2e-pattern customer +
  //      driver row, but FIRST move any punches that were attributed to
  //      those stubs into `quarantined_punches` for forensics. All
  //      side-table rows that reference the deleted ids are wiped too.
  //
  // Everything runs inside a single transaction (the DO block); a partial
  // failure rolls the whole thing back. Marker-gated so subsequent
  // deploys are no-ops, and pattern-matched (not id-pinned) so any
  // future leak of the same shape is also cleaned up the first time
  // this fixup lands on that environment.
  {
    name: "purge e2e onboarding leakage (Task #359)",
    describe:
      "Quarantine punches attributed to e2e-pattern stub drivers/customers, then hard-delete the stub rows and every side-table row referencing them.",
    detect: `SELECT 1`,
    apply: `
      CREATE TABLE IF NOT EXISTS schema_fixup_markers (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS quarantined_punches (
        id serial PRIMARY KEY,
        quarantined_at timestamptz NOT NULL DEFAULT now(),
        quarantine_reason text NOT NULL,
        original_driver_name text,
        original_driver_customer text,
        original_punch_id integer NOT NULL,
        week_start date NOT NULL,
        kfi_id text NOT NULL,
        customer text,
        source text NOT NULL,
        date text NOT NULL,
        clock_in text NOT NULL,
        clock_out text NOT NULL,
        hours numeric(7,3) NOT NULL,
        pay_type text,
        disp_tz text NOT NULL DEFAULT 'America/Chicago',
        is_manual boolean NOT NULL DEFAULT false,
        edited boolean NOT NULL DEFAULT false,
        ct_external_key text,
        file_origin text,
        created_by integer,
        updated_by integer,
        reviewed_by integer,
        reviewed_at timestamptz,
        flagged_for_review boolean NOT NULL DEFAULT false,
        flagged_by integer,
        flagged_at timestamptz,
        original_created_at timestamptz,
        original_updated_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS quarantined_punches_week_kfi_idx
        ON quarantined_punches (week_start, kfi_id);
      CREATE INDEX IF NOT EXISTS quarantined_punches_quarantined_at_idx
        ON quarantined_punches (quarantined_at);
      DO $$
      DECLARE
        e2e_kfi_ids text[];
      BEGIN
        IF EXISTS (
          SELECT 1 FROM schema_fixup_markers
          WHERE name = 'purge_e2e_onboarding_leak_2026'
        ) THEN
          RETURN;
        END IF;

        -- Snapshot which kfi_ids are doomed so we can use the list
        -- across multiple statements without re-evaluating the pattern.
        SELECT COALESCE(array_agg(kfi_id), ARRAY[]::text[])
          INTO e2e_kfi_ids
          FROM drivers
         WHERE name ILIKE 'E2E %'
            OR name ILIKE '%e2e-onb-%'
            OR customer ILIKE 'E2E %'
            OR customer ILIKE '%e2e-onb-%'
            OR (name ILIKE '%Stub%'
                AND (name ILIKE '%e2e%' OR customer ILIKE '%e2e%'));

        -- 1. Quarantine punches attributed to a stub driver (by kfi_id).
        INSERT INTO quarantined_punches (
          quarantine_reason, original_driver_name, original_driver_customer,
          original_punch_id, week_start, kfi_id, customer, source, date,
          clock_in, clock_out, hours, pay_type, disp_tz, is_manual, edited,
          ct_external_key, file_origin, created_by, updated_by, reviewed_by,
          reviewed_at, flagged_for_review, flagged_by, flagged_at,
          original_created_at, original_updated_at
        )
        SELECT 'task-359 e2e stub driver kfi_id match',
               d.name, d.customer,
               p.id, p.week_start, p.kfi_id, p.customer, p.source, p.date,
               p.clock_in, p.clock_out, p.hours, p.pay_type, p.disp_tz,
               p.is_manual, p.edited, p.ct_external_key, p.file_origin,
               p.created_by, p.updated_by, p.reviewed_by, p.reviewed_at,
               p.flagged_for_review, p.flagged_by, p.flagged_at,
               p.created_at, p.updated_at
          FROM punches p
          JOIN drivers d ON d.kfi_id = p.kfi_id
         WHERE p.kfi_id = ANY(e2e_kfi_ids);

        DELETE FROM punches WHERE kfi_id = ANY(e2e_kfi_ids);

        -- 2. Defensive: also quarantine any punches whose customer
        -- column matches the e2e pattern even when the kfi_id no longer
        -- maps to a stub row (e.g. the spec's per-process suffix had
        -- not yet been added at write time).
        INSERT INTO quarantined_punches (
          quarantine_reason, original_driver_name, original_driver_customer,
          original_punch_id, week_start, kfi_id, customer, source, date,
          clock_in, clock_out, hours, pay_type, disp_tz, is_manual, edited,
          ct_external_key, file_origin, created_by, updated_by, reviewed_by,
          reviewed_at, flagged_for_review, flagged_by, flagged_at,
          original_created_at, original_updated_at
        )
        SELECT 'task-359 e2e customer pattern match',
               NULL, p.customer,
               p.id, p.week_start, p.kfi_id, p.customer, p.source, p.date,
               p.clock_in, p.clock_out, p.hours, p.pay_type, p.disp_tz,
               p.is_manual, p.edited, p.ct_external_key, p.file_origin,
               p.created_by, p.updated_by, p.reviewed_by, p.reviewed_at,
               p.flagged_for_review, p.flagged_by, p.flagged_at,
               p.created_at, p.updated_at
          FROM punches p
         WHERE p.customer ILIKE 'E2E %'
            OR p.customer ILIKE '%e2e-onb-%';

        DELETE FROM punches
         WHERE customer ILIKE 'E2E %'
            OR customer ILIKE '%e2e-onb-%';

        -- 3. Wipe side-table rows keyed by a doomed kfi_id.
        BEGIN
          DELETE FROM driver_id_aliases
           WHERE kfi_id = ANY(e2e_kfi_ids)
              OR customer ILIKE 'E2E %'
              OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM driver_customer_overrides
           WHERE kfi_id = ANY(e2e_kfi_ids)
              OR override_customer ILIKE 'E2E %'
              OR override_customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM driver_notes WHERE kfi_id = ANY(e2e_kfi_ids);
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM reviewed_drivers WHERE kfi_id = ANY(e2e_kfi_ids);
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM driver_week_audit_log WHERE kfi_id = ANY(e2e_kfi_ids);
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM connecteam_user_aliases WHERE kfi_id = ANY(e2e_kfi_ids);
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM connecteam_daily_snapshots WHERE kfi_id = ANY(e2e_kfi_ids);
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM driver_payroll_profiles WHERE kfi_id = ANY(e2e_kfi_ids);
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM punch_deletions
           WHERE kfi_id = ANY(e2e_kfi_ids)
              OR customer ILIKE 'E2E %'
              OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;

        -- 4. Wipe side-table rows keyed by an e2e customer name.
        BEGIN
          DELETE FROM customer_name_aliases
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM customer_column_schemas
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM ai_extract_samples
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM customer_upload_attempts
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM customer_ignored_externals
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM customer_tz_preferences
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM customer_alias_audit_log
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM ai_extract_chunk_stage
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;
        BEGIN
          DELETE FROM ingestion_runs
           WHERE customer ILIKE 'E2E %' OR customer ILIKE '%e2e-onb-%';
        EXCEPTION WHEN undefined_table THEN NULL; END;

        -- 5. Hard-delete the stub driver and customer rows themselves.
        DELETE FROM drivers
         WHERE kfi_id = ANY(e2e_kfi_ids);
        DELETE FROM customers
         WHERE display_name ILIKE 'E2E %'
            OR display_name ILIKE '%e2e-onb-%';

        INSERT INTO schema_fixup_markers (name)
          VALUES ('purge_e2e_onboarding_leak_2026')
          ON CONFLICT (name) DO NOTHING;
      END$$;
    `,
  },
];

// ---------------------------------------------------------------------
// Person-name normalization helper (mirror of
// `artifacts/api-server/src/lib/parsers/displayName.ts` and
// `artifacts/kfi-ot/src/lib/format-name.ts`). Inlined here because this
// script is its own pnpm package and can't import from an artifact.
// Keep these three implementations in sync.
// ---------------------------------------------------------------------
const ROMAN_NUMERAL =
  /^(?:M{0,3})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
function isRomanNumeral(word: string): boolean {
  if (word.length === 0 || word.length > 4) return false;
  const upper = word.toUpperCase();
  if (!/^[IVX]+$/.test(upper)) return false;
  return ROMAN_NUMERAL.test(upper) && upper !== "";
}
function isInitial(word: string): boolean {
  return /^\p{L}\.$/u.test(word);
}
function capFirstRestLower(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLocaleUpperCase() + s.slice(1).toLocaleLowerCase();
}
function capWord(word: string): string {
  if (word.length === 0) return word;
  if (isInitial(word)) return word.charAt(0).toLocaleUpperCase() + ".";
  if (isRomanNumeral(word)) return word.toUpperCase();
  if (/^mc\p{L}/iu.test(word)) {
    return (
      "Mc" +
      word.charAt(2).toLocaleUpperCase() +
      word.slice(3).toLocaleLowerCase()
    );
  }
  return capFirstRestLower(word);
}
function capApostropheAware(part: string): string {
  if (!/['\u2019]/.test(part)) return capWord(part);
  const segs = part.split(/(['\u2019])/);
  return segs
    .map((seg, i) => {
      if (seg === "'" || seg === "\u2019") return seg;
      const prev = segs[i - 1];
      if (prev === "'" || prev === "\u2019") return capFirstRestLower(seg);
      return capWord(seg);
    })
    .join("");
}
function capHyphenated(token: string): string {
  if (!token.includes("-")) return capApostropheAware(token);
  return token.split("-").map(capApostropheAware).join("-");
}
function toDisplayName(input: string | null | undefined): string {
  if (input == null) return "";
  const trimmed = input.trim();
  if (!trimmed) return input ?? "";
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return input;
  const hasUpper = letters !== letters.toLocaleLowerCase();
  const hasLower = letters !== letters.toLocaleUpperCase();
  if (hasUpper && hasLower) return input;
  return trimmed.split(/\s+/).map(capHyphenated).join(" ");
}

/**
 * Idempotent backfill: rewrite any `drivers.name` and
 * `customer_name_aliases.name_on_doc` rows whose stored value equals its
 * own upper-case form (i.e. is ALL-CAPS) into Title Case. Mixed-case rows
 * are untouched. Safe to re-run.
 */
async function backfillDisplayNames(client: pg.Client): Promise<void> {
  // drivers.name
  const drivers = await client.query<{ kfi_id: string; name: string }>(
    `SELECT kfi_id, name FROM drivers WHERE name = upper(name) AND name ~ '[A-Za-zÀ-ÿ]'`,
  );
  if (drivers.rowCount && drivers.rowCount > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[pre-migrate] backfilling driver name casing for ${drivers.rowCount} rows`,
    );
    for (const row of drivers.rows) {
      const next = toDisplayName(row.name);
      if (next && next !== row.name) {
        await client.query(`UPDATE drivers SET name = $1 WHERE kfi_id = $2`, [
          next,
          row.kfi_id,
        ]);
      }
    }
  }
  // customer_name_aliases.name_on_doc
  const aliases = await client.query<{
    customer: string;
    name_on_doc: string;
  }>(
    `SELECT customer, name_on_doc FROM customer_name_aliases
     WHERE name_on_doc = upper(name_on_doc) AND name_on_doc ~ '[A-Za-zÀ-ÿ]'`,
  );
  if (aliases.rowCount && aliases.rowCount > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[pre-migrate] backfilling customer_name_aliases.name_on_doc casing for ${aliases.rowCount} rows`,
    );
    for (const row of aliases.rows) {
      const next = toDisplayName(row.name_on_doc);
      if (next && next !== row.name_on_doc) {
        // Index is on lower(name_on_doc) so the case rewrite preserves
        // uniqueness; the UPDATE is safe.
        await client.query(
          `UPDATE customer_name_aliases
             SET name_on_doc = $1
             WHERE customer = $2 AND name_on_doc = $3`,
          [next, row.customer, row.name_on_doc],
        );
      }
    }
  }
}

async function main() {
  const startedAt = new Date();
  // Republish safety (Task #402): refuse to run any DELETE FROM punches
  // fixup against a production DB unless the operator has explicitly
  // opted in via KFI_ALLOW_BULK_PUNCH_DELETE=1. See preMigrateGuard.ts.
  const decision = evaluatePreMigrateGuard(
    {
      nodeEnv: process.env.NODE_ENV,
      optIn: process.env[PRE_MIGRATE_OPT_IN_ENV],
    },
    FIXUPS.map((f) => f.name),
  );
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (decision.outcome === "refuse") {
      await recordPreMigrateAudit(
        client,
        "refused",
        decision.reason,
        startedAt,
      );
      // eslint-disable-next-line no-console
      console.error(`[pre-migrate] ${decision.reason}`);
      throw new Error(decision.reason);
    }
    for (const fixup of FIXUPS) {
      const detected = await client.query(fixup.detect);
      if (detected.rowCount && detected.rowCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[pre-migrate] applying: ${fixup.name}`);
        await client.query(fixup.apply);
      }
    }
    await backfillDisplayNames(client);
    await recordPreMigrateAudit(client, "ok", decision.reason, startedAt);
  } catch (err) {
    if (!(err instanceof Error && err.message === decision.reason)) {
      await recordPreMigrateAudit(
        client,
        "error",
        err instanceof Error ? err.message : String(err),
        startedAt,
      );
    }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[pre-migrate] failed:", err);
  process.exit(1);
});
