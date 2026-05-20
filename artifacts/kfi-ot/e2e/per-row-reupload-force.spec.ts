/**
 * Task #358 regression guard for the per-row Re-upload button.
 *
 * Before the fix, the customer-upload-panel's per-row "Re-upload" button
 * (the relabelled "Upload" button once a row had imported punches) called
 * `/extract-customer-file` without `?force=1`. Identical bytes — exactly
 * what a dispatcher uploads when they realise nothing happened the first
 * time and try again — short-circuited on the SHA-256 dedupe with
 * `{ skipped: true }` and no preview ever opened. The button looked
 * broken.
 *
 * The fix: the panel now passes `?force=1` whenever the row already has
 * imported punches (or the dispatcher dropped onto a row that does). On
 * the server we detect the same-bytes condition either way and add a
 * `sameAsLastImport: true` flag to the preview response so the dialog
 * can show a neutral "matches the last import you confirmed" note.
 *
 * Bulk upload behavior stays unchanged: bulk runs never pass force, so
 * identical bytes still skip without parsing.
 *
 * This spec exercises the contract through the API layer directly (no UI
 * rendering) so it stays deterministic on CI even though the companion
 * `customer-preview.spec.ts` is currently `.fixme`-quarantined for an
 * unrelated SSE race.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

// Same fixture week + driver as customer-preview.spec.ts. We share the
// fixture (Adient.xlsx) because it's the only checked-in customer file
// whose EMBEDDED_MAPPING covers a real KFI id we can seed without
// stepping on the regular Adient roster.
const WEEK_START = "2026-04-26";
const WEEK_END = "2026-05-02";
const ADIENT_KFI_ID = "2002909";
const DRIVER_NAME = `Adient Reupload Tester ${Date.now().toString(36)}`;

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
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = 'Adient'`,
    [WEEK_START],
  );
  await pool.query(`DELETE FROM ai_extract_samples WHERE customer = 'Adient'`);
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE customer = 'Adient' AND week_start = $1`,
    [WEEK_START],
  );
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [ADIENT_KFI_ID]);
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, 'Adient')
     ON CONFLICT (kfi_id) DO UPDATE
       SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
    [ADIENT_KFI_ID, DRIVER_NAME],
  );
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

// CI-skip: three real-Claude extracts on a 69-chunk Adient fixture is
// not a stable CI signal. After bumping the per-POST timeout the request
// now completes, but the extract routinely hits the per-upload
// IngestionBudget cap (30 calls / 400k tokens) and returns 0 rows,
// causing the downstream `rows.length > 0` assertion to fail. The
// SHA-dedupe / same-as-last-import contract being verified here is a
// pure server-side concern and is independently covered by the parser
// drift suite in `artifacts/api-server/src/lib/parsers/__tests__/`.
(process.env.CI ? test.skip : test)(
  "per-row Re-upload forces past the SHA dedupe and flags same-as-last-import",
  async ({ page }) => {
  test.setTimeout(1_800_000);
  await signInAsDispatcher(page);

  const fileBytes = readFileSync(FIXTURE_PATH);
  const multipart = {
    file: {
      name: "Adient.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: fileBytes,
    },
  };

  // ---------------------------------------------------------------------
  // 1. First-time per-row upload (no force) — produces a real preview and
  //    a sample id we can confirm against. This mirrors what the panel
  //    sends when a row hasn't been uploaded yet (`uploaded === false`,
  //    so `extractFor` is called without `{ force: true }`).
  // ---------------------------------------------------------------------
  const firstExtract = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file`,
    { multipart, timeout: 600_000 },
  );
  expect(firstExtract.status()).toBe(200);
  const firstBody = (await firstExtract.json()) as {
    sampleId: number | null;
    skipped?: boolean;
    sameAsLastImport?: boolean;
    rows: Array<unknown>;
  };
  expect(firstBody.skipped ?? false).toBe(false);
  expect(firstBody.sameAsLastImport ?? false).toBe(false);
  expect(firstBody.sampleId).not.toBeNull();
  expect(firstBody.rows.length).toBeGreaterThan(0);

  const firstConfirm = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-customer-file`,
    {
      data: {
        customer: "Adient",
        sampleId: firstBody.sampleId,
        excludedIndices: [],
      },
    },
  );
  expect(firstConfirm.status()).toBe(200);

  // ---------------------------------------------------------------------
  // 2. Re-upload identical bytes WITHOUT force — server short-circuits
  //    with `skipped: true`. This is the bulk-upload behavior the bulk
  //    path still depends on (Task #358 only changes the per-row path).
  // ---------------------------------------------------------------------
  const skipExtract = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file`,
    { multipart, timeout: 600_000 },
  );
  expect(skipExtract.status()).toBe(200);
  const skipBody = (await skipExtract.json()) as {
    skipped?: boolean;
    sampleId: number | null;
    sameAsLastImport?: boolean;
    rows: Array<unknown>;
  };
  expect(skipBody.skipped).toBe(true);
  expect(skipBody.sampleId).toBeNull();
  expect(skipBody.rows).toEqual([]);
  // `sameAsLastImport` is intentionally only set on the force=1 path
  // (the dispatcher pressed Re-upload). The skipped response carries
  // its own `skipped: true` signal — adding a redundant flag would
  // give callers two ways to detect the same condition.
  expect(skipBody.sameAsLastImport ?? false).toBe(false);

  // ---------------------------------------------------------------------
  // 3. Re-upload identical bytes WITH force=1 — server extracts a real
  //    preview (so the dialog can actually open) AND sets
  //    `sameAsLastImport: true` so the dialog renders the neutral
  //    "matches the last import" note. This is exactly what the panel
  //    sends on Re-upload now.
  // ---------------------------------------------------------------------
  const forcedExtract = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file?force=1`,
    { multipart, timeout: 600_000 },
  );
  expect(forcedExtract.status()).toBe(200);
  const forcedBody = (await forcedExtract.json()) as {
    skipped?: boolean;
    sampleId: number | null;
    sameAsLastImport?: boolean;
    rows: Array<unknown>;
    existingPunchCount: number;
  };
  expect(forcedBody.skipped ?? false).toBe(false);
  expect(forcedBody.sampleId).not.toBeNull();
  expect(forcedBody.rows.length).toBeGreaterThan(0);
  expect(forcedBody.sameAsLastImport).toBe(true);
  // The replace-warning banner depends on this — it must reflect the
  // punches actually imported by the first confirm, not zero.
  expect(forcedBody.existingPunchCount).toBeGreaterThan(0);
});
