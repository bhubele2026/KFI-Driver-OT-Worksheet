/**
 * End-to-end coverage for the known-customer extract / confirm preview flow.
 *
 * Verifies:
 *   - Picking a known-customer file (Adient.xlsx fixture) opens the preview
 *     dialog WITHOUT writing any punches to the DB.
 *   - Cancel = no rows persisted.
 *   - Confirm with an excluded row = (parsedCount - 1) Customer-source rows.
 *   - Re-uploading and confirming again replaces the previously-imported
 *     rows atomically (same wipe-and-reinsert semantics as the legacy
 *     extract-customer-file endpoint).
 *
 * Seeds a clean week + a single Adient driver (kfiId 2002909, the only id in
 * the Adient.xlsx fixture that maps through EMBEDDED_MAPPING for this sample
 * week) via direct DB writes, runs the flow against the real /api routes
 * through the dashboard, and cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the customer-preview e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

// The dashboard route accepts any in-week date; the server snaps to the
// Sunday-aligned week start via `ensureWeek` (Sun→Sat payroll week). Use the
// snapped value (2026-04-26 = the Sunday that anchors the fixture week — the
// fixture lives under fixtures/2026-04-26/Adient.xlsx) for all DB cleanup,
// seeding, and count queries — otherwise the cleanup deletes the wrong week
// and previous rows leak across runs.
const WEEK_START = "2026-04-26";
const WEEK_END = "2026-05-02";
const ADIENT_KFI_ID = "2002909";
const DRIVER_NAME = `Adient Preview Tester ${Date.now().toString(36)}`;

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

async function clearPunches(): Promise<void> {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = 'Adient'`,
    [WEEK_START],
  );
}

async function countAdientPunches(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM punches
       WHERE week_start = $1 AND customer = 'Adient'
         AND source = 'Customer' AND is_manual = false`,
    [WEEK_START],
  );
  return Number(r.rows[0]?.n ?? "0");
}

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
       ON CONFLICT (start_date) DO NOTHING`,
      [WEEK_START, WEEK_END],
    );
    await client.query(
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, 'Adient')
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
      [ADIENT_KFI_ID, DRIVER_NAME],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  await clearPunches();
  await pool.query(`DELETE FROM ai_extract_samples WHERE customer = 'Adient'`);
  await pool.query(`DELETE FROM customer_upload_attempts WHERE customer = 'Adient' AND week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [ADIENT_KFI_ID]);
}

// The Adient parser resolves badge ids to KFI drivers via the static
// EMBEDDED_MAPPING in `lib/mappings.ts` PLUS any admin-managed rows in
// `driver_id_aliases`. In a fresh CI database only the 4 hard-coded
// TELD entries apply, but other e2e specs in this repo leak TELD aliases
// into the dev DB (e.g. KFI-AR1-e2e-…), and accumulated aliases pollute
// the preview row count. To keep this spec deterministic we snapshot
// every TELD alias plus every driver that those aliases (or the
// hard-coded EMBEDDED_MAPPING TELD entries) resolve to in beforeAll,
// wipe them, run the test against a clean Adient mapping (only the
// seeded test driver remains mappable), then restore the snapshot in
// afterAll so subsequent specs see the pre-existing state.
const HARDCODED_ADIENT_KFI_IDS = ["2004651", "2003546", "2004805"];

type DriverRow = {
  kfi_id: string;
  name: string;
  customer: string | null;
  display_tz: string | null;
};
type AliasRow = {
  external_id: string;
  kfi_id: string;
  created_by: number | null;
  updated_by: number | null;
  note: string | null;
};

let aliasSnapshot: AliasRow[] = [];
let driverSnapshot: DriverRow[] = [];

async function snapshotAndIsolate(): Promise<void> {
  const aliases = await pool.query<AliasRow>(
    `SELECT external_id, kfi_id, created_by, updated_by, note
       FROM driver_id_aliases
      WHERE external_id LIKE 'TELD%'`,
  );
  aliasSnapshot = aliases.rows;

  const polluterKfiIds = Array.from(
    new Set([...HARDCODED_ADIENT_KFI_IDS, ...aliasSnapshot.map((a) => a.kfi_id)]),
  ).filter((k) => k !== ADIENT_KFI_ID);

  if (polluterKfiIds.length > 0) {
    const drivers = await pool.query<DriverRow>(
      `SELECT kfi_id, name, customer, display_tz FROM drivers
        WHERE kfi_id = ANY($1::text[])`,
      [polluterKfiIds],
    );
    driverSnapshot = drivers.rows;

    // Deleting the driver cascades through driver_id_aliases (FK ON
    // DELETE CASCADE), so the alias rows go with it.
    await pool.query(`DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`, [
      polluterKfiIds,
    ]);
  } else {
    driverSnapshot = [];
  }

  // Belt-and-suspenders: explicitly drop any remaining TELD aliases that
  // referenced kfiIds we did NOT delete (shouldn't happen, but safe).
  await pool.query(`DELETE FROM driver_id_aliases WHERE external_id LIKE 'TELD%'`);
}

async function restoreSnapshot(): Promise<void> {
  for (const d of driverSnapshot) {
    await pool.query(
      `INSERT INTO drivers (kfi_id, name, customer, display_tz)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name,
             customer = EXCLUDED.customer,
             display_tz = EXCLUDED.display_tz`,
      [d.kfi_id, d.name, d.customer, d.display_tz],
    );
  }
  for (const a of aliasSnapshot) {
    await pool.query(
      `INSERT INTO driver_id_aliases (external_id, kfi_id, created_by, updated_by, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (external_id) DO UPDATE
         SET kfi_id = EXCLUDED.kfi_id,
             updated_by = EXCLUDED.updated_by,
             note = EXCLUDED.note`,
      [a.external_id, a.kfi_id, a.created_by, a.updated_by, a.note],
    );
  }
}

test.beforeAll(async () => {
  await cleanup();
  await snapshotAndIsolate();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await restoreSnapshot();
  await pool.end();
});

// Quarantined: pre-existing race + retry state-leak (task #150). See follow-up #193.
test.fixme("dispatcher previews a known-customer upload and only persists on Confirm", async ({
  page,
}) => {
  // Sign in via the dev auth bypass directly so the cookie is set
  // before we navigate. The dashboard keeps an SSE /api/events
  // connection open continuously, so `networkidle` is unreliable
  // here — wait on a concrete DOM signal instead (the heading /
  // sidebar is rendered as soon as the week summary query resolves).
  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`);

  const adientRow = page
    .locator("li")
    .filter({ hasText: /^Adient/ })
    .first();
  await expect(adientRow).toBeVisible({ timeout: 30_000 });

  // Baseline: no Adient customer-source punches.
  expect(await countAdientPunches()).toBe(0);

  // ---------------------------------------------------------------------
  // 1. Pick the fixture file → preview dialog opens, nothing is written.
  // ---------------------------------------------------------------------
  const fileInputs = page.locator('input[type="file"]');
  // The Adient row is one of several hidden inputs; find by index by
  // matching the row order. Easier: trigger by clicking the row's Upload
  // button which clicks the hidden input. Use setInputFiles on the matching
  // input. Adient is the first KNOWN_CUSTOMERS row, so its hidden input is
  // the first .xlsx-accepting one. Filter by accept attribute.
  const adientInput = adientRow.locator('input[type="file"]');
  await expect(adientInput).toHaveCount(1);
  await adientInput.setInputFiles(FIXTURE_PATH);

  const previewDialog = page.getByRole("dialog", {
    name: /Review Adient upload/i,
  });
  await expect(previewDialog).toBeVisible();
  // 5 rows in the fixture for KFI driver 2002909.
  const previewRows = previewDialog.locator('[data-testid^="row-preview-"]');
  await expect(previewRows).toHaveCount(5);
  // Existing count is 0 so the amber "will replace" banner doesn't show; the
  // neutral "Will import N punches" line does.
  await expect(previewDialog).toContainText(/Will import 5 punches/i);
  // Rows are grouped by driver — all 5 rows are for the same kfiId so we
  // expect exactly one group header.
  await expect(
    previewDialog.locator(`[data-testid="row-driver-group-${ADIENT_KFI_ID}"]`),
  ).toHaveCount(1);
  // Each preview row exposes a source-row hint so the dispatcher can find
  // the matching line in the original file.
  await expect(previewDialog).toContainText(/row 1 of Adient\.xlsx/i);
  // Adient.xlsx in this fixture has 57 unmapped TELD ids.
  await expect(
    previewDialog.getByTestId("text-unmapped-warning"),
  ).toBeVisible();

  // Sanity: still no DB writes after extract.
  expect(await countAdientPunches()).toBe(0);
  const samplesBefore = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_extract_samples WHERE customer = 'Adient'`,
  );
  expect(Number(samplesBefore.rows[0].n)).toBe(1);

  // ---------------------------------------------------------------------
  // 2. Cancel = no writes AND the stashed sample is discarded immediately
  //    (we don't keep payroll bytes around for the full 24h TTL when we
  //    know they'll never be confirmed).
  // ---------------------------------------------------------------------
  await previewDialog.getByTestId("button-cancel-import").click();
  await expect(previewDialog).not.toBeVisible();
  expect(await countAdientPunches()).toBe(0);
  await expect
    .poll(async () => {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ai_extract_samples WHERE customer = 'Adient'`,
      );
      return Number(r.rows[0]?.n ?? "0");
    })
    .toBe(0);

  // ---------------------------------------------------------------------
  // 3. Re-upload, exclude the first row, confirm → 4 punches imported.
  //    The dialog auto-pre-fills each unmapped-id picker with its top
  //    fuzzy suggestion, and with the polluter drivers deleted only the
  //    seeded test driver remains as a candidate — so clicking the
  //    Confirm button would inadvertently submit 57 TELD→2002909 alias
  //    mappings and re-import every row in the file. To keep the
  //    excludedIndices wipe-and-reinsert behavior under test without
  //    fighting the picker, verify the UI selection state then send the
  //    confirm through the API with no alias picks (same pattern as
  //    step 4 below).
  // ---------------------------------------------------------------------
  await adientInput.setInputFiles(FIXTURE_PATH);
  await expect(previewDialog).toBeVisible();
  await previewDialog.getByTestId("checkbox-keep-0").click();
  await expect(previewDialog).toContainText(/4 of 5 rows selected/i);

  const stagedSample = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM ai_extract_samples WHERE customer = 'Adient'
       ORDER BY uploaded_at DESC LIMIT 1`,
  );
  const stagedSampleId = Number(stagedSample.rows[0]?.id);
  expect(Number.isFinite(stagedSampleId)).toBe(true);

  // Confirm via API while the dialog is still open — the Cancel button
  // wires through to /cancel-customer-file and would purge the staged
  // sample we're about to confirm against.
  const firstConfirm = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-customer-file`,
    {
      data: {
        customer: "Adient",
        sampleId: stagedSampleId,
        excludedIndices: [0],
      },
    },
  );
  expect(firstConfirm.status()).toBe(200);

  await expect.poll(() => countAdientPunches()).toBe(4);

  // Dismiss the now-stale dialog so it doesn't intercept any later
  // interactions. Cancel is a no-op against the already-purged sample.
  await previewDialog.getByTestId("button-cancel-import").click();
  await expect(previewDialog).not.toBeVisible();

  // ---------------------------------------------------------------------
  // 4. Re-confirm directly through the API (avoids UI re-render flakiness)
  //    to verify the wipe-and-reinsert tx: prior 4 customer rows are
  //    replaced by all 5 from the fresh extract.
  // ---------------------------------------------------------------------
  // `?force=1` bypasses the SHA-256 no-op skip-detection: this test
  // intentionally re-uploads the same fixture bytes that the prior
  // confirm just imported, and we want a fresh preview, not a "skipped"
  // short-circuit. The bulk-upload path relies on the skip; per-row
  // Re-upload and explicit re-tests like this one opt out.
  const reExtract = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file?force=1`,
    {
      multipart: {
        file: {
          name: "Adient.xlsx",
          mimeType: "application/octet-stream",
          buffer: readFileSync(FIXTURE_PATH),
        },
      },
    },
  );
  expect(reExtract.status()).toBe(200);
  const reBody = (await reExtract.json()) as {
    sampleId: number;
    existingPunchCount: number;
    rows: Array<{ index: number }>;
  };
  expect(reBody.existingPunchCount).toBe(4);
  expect(reBody.rows.length).toBe(5);

  const reConfirm = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-customer-file`,
    {
      data: {
        customer: "Adient",
        sampleId: reBody.sampleId,
        excludedIndices: [],
      },
    },
  );
  expect(reConfirm.status()).toBe(200);

  await expect.poll(() => countAdientPunches()).toBe(5);

  // Sample is purged inside the confirm tx — payroll bytes aren't kept
  // past the moment we commit them as real punches.
  const samplesAfter = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_extract_samples WHERE customer = 'Adient'`,
  );
  expect(Number(samplesAfter.rows[0].n)).toBe(0);
});
