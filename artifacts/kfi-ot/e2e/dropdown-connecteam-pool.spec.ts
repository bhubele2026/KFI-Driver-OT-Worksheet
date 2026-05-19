/**
 * Verifies that the per-id "this is actually driver X" dropdown in the
 * bulk customer-file preview only suggests drivers who actually punched
 * in via Connecteam for the week being uploaded.
 *
 * Without that restriction the picker lists every active driver in the
 * roster (including e2e fixtures and never-clocked drivers), and
 * dispatchers easily mis-map a name to someone who wasn't even working.
 *
 * Strategy:
 *   1. Seed a clean future week + two ghost drivers whose names match
 *      Adient.xlsx employees ("AGUIRRE, DIEGO" and "ALVIZO, JOSE").
 *   2. Insert a Connecteam (source=Driver) punch only for the AGUIRRE
 *      driver — ALVIZO has no Connecteam time for the week.
 *   3. POST the Adient.xlsx fixture to /extract-customer-file.
 *   4. Walk every unmappedIds[].suggestions[] in the response and assert
 *      the ALVIZO ghost kfiId never appears (filter excludes him), while
 *      the AGUIRRE kfiId is allowed to appear (he's the only candidate
 *      in the pool, plus his name fuzzy-matches "AGUIRRE, DIEGO (TELDxxx)"
 *      well above 0.85).
 *
 * This spec deliberately uses a far-future week and unique kfiIds so it
 * never collides with other suites' Adient/TELD state, and it does NOT
 * touch driver_id_aliases — keeping the snapshot/restore dance other
 * Adient specs need out of scope.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the dropdown-connecteam-pool e2e test.",
  );
}
const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = Date.now().toString(36);
// Match the 2026-04-26 Adient fixture's pay period (the parser maps
// the fixture's 5/04/2026 dates back into this Sunday-anchored payroll
// week). customer-preview.spec.ts also uses this week; we keep our
// seeded kfiIds in a distinct range so neither cleanup wipes the other.
const WEEK_START = "2026-04-26";
const WEEK_END = "2026-05-02";
const PUNCHED_KFI_ID = `91${SUFFIX.slice(-6)}`.slice(0, 8);
const GHOST_KFI_ID = `92${SUFFIX.slice(-6)}`.slice(0, 8);
const PUNCHED_NAME = "AGUIRRE, DIEGO";
const GHOST_NAME = "ALVIZO, JOSE";
// One TELD id from the fixture, used purely to seed a driver_id_alias
// so the parser resolves at least one row → punch. Without this the
// route returns 400 ("0 punches") and falls into AI fallback which
// rate-limits in CI. We deliberately pick a row whose doc-name
// ("BACHER, SARAH") doesn't collide with PUNCHED_NAME/GHOST_NAME, so
// AGUIRRE/ALVIZO both stay in the unmappedIds → suggestions partition
// that the assertions below depend on.
const ALIAS_TELD_ID = "TELD1148";

type SnapshotAlias = {
  external_id: string;
  kfi_id: string;
  created_by: number | null;
  updated_by: number | null;
  note: string | null;
};
let aliasSnapshot: SnapshotAlias | null = null;

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  here,
  "..",
  "..",
  "api-server",
  "src",
  "lib",
  "parsers",
  "__tests__",
  "fixtures",
  "2026-04-26",
  "Adient.xlsx",
);

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM ai_extract_samples WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE week_start = $1`,
    [WEEK_START],
  );
  await pool.query(`DELETE FROM driver_id_aliases WHERE external_id = $1`, [
    ALIAS_TELD_ID,
  ]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`, [
    [PUNCHED_KFI_ID, GHOST_KFI_ID],
  ]);
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
       ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer) VALUES
       ($1, $2, 'Adient'),
       ($3, $4, 'Adient')
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
    [PUNCHED_KFI_ID, PUNCHED_NAME, GHOST_KFI_ID, GHOST_NAME],
  );
  // Map ONE Adient TELD id → PUNCHED driver so the deterministic parser
  // resolves at least one punch and we don't fall into the AI fallback
  // path. All other TELD ids in the fixture remain unmapped, which is
  // exactly what we want — those unmapped ids carry the suggestions[]
  // arrays we assert against.
  await pool.query(
    `INSERT INTO driver_id_aliases (external_id, kfi_id) VALUES ($1, $2)`,
    [ALIAS_TELD_ID, PUNCHED_KFI_ID],
  );
  // One Connecteam (source=Driver) punch for the PUNCHED driver only.
  // The GHOST driver intentionally has NO Connecteam rows so we can
  // assert he's excluded from the candidate pool.
  await pool.query(
    `INSERT INTO punches
       (kfi_id, week_start, date, clock_in, clock_out, hours, source, is_manual)
     VALUES
       ($1, $2, '2026-04-27', '2026-04-27 7:00 AM', '2026-04-27 3:00 PM', 8, 'Driver', false)`,
    [PUNCHED_KFI_ID, WEEK_START],
  );
}

test.beforeAll(async () => {
  // Snapshot any pre-existing alias for TELD664 (other suites may have
  // leaked one) so we restore it in afterAll.
  const r = await pool.query<SnapshotAlias>(
    `SELECT external_id, kfi_id, created_by, updated_by, note
       FROM driver_id_aliases WHERE external_id = $1`,
    [ALIAS_TELD_ID],
  );
  aliasSnapshot = r.rows[0] ?? null;
  await cleanup();
  await seed();
});
test.afterAll(async () => {
  await cleanup();
  if (aliasSnapshot) {
    await pool.query(
      `INSERT INTO driver_id_aliases (external_id, kfi_id, created_by, updated_by, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (external_id) DO NOTHING`,
      [
        aliasSnapshot.external_id,
        aliasSnapshot.kfi_id,
        aliasSnapshot.created_by,
        aliasSnapshot.updated_by,
        aliasSnapshot.note,
      ],
    );
  }
  await pool.end();
});

// Skipped in CI: hits real Gemini via /extract-customer-file, which times out
// at Playwright's 10s actionTimeout and exhausts the AI proxy rate limit.
// Tracked by follow-up task #285 (add HTTP-level fake-Gemini mode).
(process.env.CI ? test.skip : test)("extract-customer-file restricts driver suggestions to Connecteam-active pool", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  const buf = await fs.readFile(FIXTURE_PATH);
  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file?force=1`,
    {
      multipart: {
        file: {
          name: "Adient.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: buf,
        },
      },
    },
  );
  expect(res.status(), await res.text().catch(() => "")).toBe(200);
  const body = (await res.json()) as {
    customer: string;
    unmappedIds: Array<{
      id: string;
      sampleName: string | null;
      suggestions: Array<{ kfiId: string; name: string; confidence: number }>;
    }>;
  };
  expect(body.customer).toBe("Adient");
  // Sanity: the fixture has many TELD ids that EMBEDDED_MAPPING +
  // our seeded alias don't resolve, so the response must surface
  // some unmapped ids for the suggestions test to be meaningful.
  expect(body.unmappedIds.length).toBeGreaterThan(0);
  const allSuggestedKfis = new Set<string>();
  for (const u of body.unmappedIds) {
    for (const s of u.suggestions) allSuggestedKfis.add(s.kfiId);
  }
  // Core assertion: the ghost driver (no Connecteam punches this week,
  // no driver_id_alias) must NEVER appear in any suggestion list, even
  // though his name "ALVIZO, JOSE" perfectly matches one of the doc's
  // employee names. Before this filter shipped, every active roster
  // driver was eligible — so this exact scenario would pre-pick the
  // wrong person.
  expect(allSuggestedKfis.has(GHOST_KFI_ID)).toBe(false);
  // Positive sanity: the Connecteam-active driver IS in the pool, and
  // his name "AGUIRRE, DIEGO" matches one of the doc's employee names
  // ("AGUIRRE, DIEGO (TELDxxx)") well above the 0.85 fuzzy floor, so
  // he should appear in at least one suggestions[]. Catches the
  // regression where the pool filter accidentally excludes everyone.
  expect(allSuggestedKfis.has(PUNCHED_KFI_ID)).toBe(true);
});
