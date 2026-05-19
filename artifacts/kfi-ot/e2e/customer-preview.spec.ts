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
// Sunday-aligned week start via `ensureWeek` (payroll runs Sun→Sat). Use
// the snapped value (2026-04-19 = Sunday) for all DB cleanup, seeding, and
// count queries — otherwise the cleanup deletes the wrong week and previous
// rows leak across runs.
const WEEK_START = "2026-04-19";
const WEEK_END = "2026-04-25";
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

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
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
  // ---------------------------------------------------------------------
  await adientInput.setInputFiles(FIXTURE_PATH);
  await expect(previewDialog).toBeVisible();
  await previewDialog.getByTestId("checkbox-keep-0").click();
  await expect(previewDialog).toContainText(/4 of 5 rows selected/i);
  await previewDialog.getByTestId("button-confirm-import").click();
  await expect(previewDialog).not.toBeVisible();

  await expect.poll(() => countAdientPunches()).toBe(4);

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
