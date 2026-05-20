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
    await backfillDisplayNames(client);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[pre-migrate] failed:", err);
  process.exit(1);
});
