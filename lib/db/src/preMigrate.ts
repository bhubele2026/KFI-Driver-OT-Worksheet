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
