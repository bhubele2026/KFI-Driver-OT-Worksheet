/**
 * Task #382 (follow-up to #381) — UI-level regression guard for the
 * per-row "already imported" toast.
 *
 * The bug: when a dispatcher dropped the same customer file twice onto a
 * per-row uploader, the second upload's `?force=` unset POST returned
 * `{ skipped: true, sampleId: null, rows: [] }`. The panel used to feed
 * that straight into the preview dialog, which rendered an empty preview
 * AND triggered `DELETE /api/weeks/:ws/extract-customer-file/null` (400)
 * when the dispatcher cancelled out of it.
 *
 * The fix branches on `data.skipped` in both per-row callers
 * (`customer-upload-panel.tsx` and `hooks/use-customer-uploads.tsx`) and
 * surfaces a neutral `customerUpload.alreadyImported*` toast instead.
 * Task #381 pinned the contract at the source level
 * (`extract-skip-shape-contract.test.ts`); this spec pins the behavior
 * end-to-end through the actual UI.
 *
 * Setup: we seed `customer_upload_attempts` with a SHA-256 that matches
 * the Burnett_G.xlsx fixture bytes (and no punches, so the panel keeps
 * `uploaded === false` and the file input sends the extract POST WITHOUT
 * `?force=1` — exactly the bulk-style code path that the bug fired on).
 * Driving the real (expensive, non-deterministic) Burnett AI extract end
 * to end would burn the per-file ingestion budget and flake on CI; the
 * pre-seeded hash is the deterministic equivalent of "the dispatcher
 * already imported these bytes once".
 */
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const WEEK_START = "2031-07-06";
const WEEK_END = "2031-07-12";
// Must match the displayName seeded into the `customers` table by
// `customers_seed_and_wipe_2026` in `lib/db/src/preMigrate.ts`. The
// "burnett" filename keyword resolves to this exact name on the server
// (`detectCustomerFromFileName`), so the row in the panel and the
// content-hash dedupe lookup both key off it.
const CUSTOMER = "Burnett Dairy-Grantsburg";

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
  "Burnett_G.xlsx",
);
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH);
const FIXTURE_HASH = createHash("sha256").update(FIXTURE_BYTES).digest("hex");

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, CUSTOMER],
  );
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, CUSTOMER],
  );
}

test.beforeAll(async () => {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await cleanup();
  // Seed a prior "successful import" attempt with a hash that exactly
  // matches the Burnett fixture bytes we're about to upload. This is the
  // deterministic equivalent of having imported the file once already.
  // `last_success_at` is required for the skip branch to fire
  // (`p.lastSuccessAt && p.lastContentHash === contentHash`). No
  // punches are seeded — that keeps the row's `uploaded` flag false in
  // the panel, so the file-input onChange handler calls extractFor WITH
  // `force` unset (exactly the code path the bug was on).
  await pool.query(
    `INSERT INTO customer_upload_attempts
       (week_start, customer, last_attempt_at, last_success_at,
        last_content_hash, last_file_name, last_source)
     VALUES ($1, $2, now(), now(), $3, 'Burnett_G.xlsx', 'ai')
     ON CONFLICT (week_start, customer) DO UPDATE
       SET last_attempt_at = EXCLUDED.last_attempt_at,
           last_success_at = EXCLUDED.last_success_at,
           last_content_hash = EXCLUDED.last_content_hash,
           last_file_name = EXCLUDED.last_file_name,
           last_source = EXCLUDED.last_source`,
    [WEEK_START, CUSTOMER, FIXTURE_HASH],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("per-row re-upload of identical bytes surfaces the alreadyImported toast — no empty preview dialog, no DELETE /…/null (#382)", async ({
  page,
}) => {
  // Watch every request the page fires while we drive the upload so we
  // can prove the cancel-side bug (DELETE /…/extract-customer-file/null)
  // never happens on the skip path.
  const deleteNullCalls: string[] = [];
  const extractPostCalls: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (
      req.method() === "DELETE" &&
      /\/api\/weeks\/[^/]+\/extract-customer-file\/null(\?|$)/.test(url)
    ) {
      deleteNullCalls.push(url);
    }
    if (
      req.method() === "POST" &&
      /\/api\/weeks\/[^/]+\/extract-customer-file(\?|$)/.test(url)
    ) {
      extractPostCalls.push(url);
    }
  });

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`, { waitUntil: "commit" });

  // The seeded customer_upload_attempts row guarantees the Burnett row
  // is rendered in the panel even with zero imported punches.
  const burnettRow = page
    .locator("li")
    .filter({ hasText: new RegExp(`^${CUSTOMER.replace(/[-/]/g, "[-/]")}`) })
    .first();
  await expect(burnettRow).toBeVisible({ timeout: 30_000 });

  const burnettInput = burnettRow.locator('input[type="file"]');
  await expect(burnettInput).toHaveCount(1);

  // Drop the same bytes the seeded attempt already "imported". The
  // panel's onChange handler sees `uploaded === false` (no punches
  // exist), so it POSTs to /extract-customer-file WITHOUT `?force=1`
  // — that's the code path where the server returns
  // `{ skipped: true, sampleId: null, rows: [] }` and where the bug
  // used to render an empty preview dialog.
  await burnettInput.setInputFiles({
    name: "Burnett_G.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: FIXTURE_BYTES,
  });

  // The neutral "already imported" toast is the contract. We assert on
  // its title text (interpolated with the customer name) — the
  // matching i18n key is `customerUpload.alreadyImportedTitle`.
  const alreadyImportedToast = page
    .locator('[data-state="open"]')
    .filter({ hasText: new RegExp(`${CUSTOMER}.*already imported`, "i") });
  await expect(alreadyImportedToast).toBeVisible({ timeout: 15_000 });

  // The whole point of the fix: the empty preview dialog must NOT open.
  // The known-customer preview dialog is titled "Review <Customer>
  // upload" (see customer-preview-dialog.tsx). Give the panel a beat
  // to settle in case the dialog would have opened racy-ly.
  await page.waitForTimeout(500);
  const previewDialog = page.getByRole("dialog", {
    name: new RegExp(`Review ${CUSTOMER}`, "i"),
  });
  await expect(previewDialog).toHaveCount(0);

  // The exact extract POST that fired must have been the no-force
  // variant (the bug's code path). Forcing on this row would not
  // exercise the skip branch at all.
  expect(extractPostCalls.length).toBeGreaterThanOrEqual(1);
  for (const url of extractPostCalls) {
    expect(url).not.toMatch(/[?&]force=/);
  }

  // The cancel-side half of the bug: a DELETE against
  // /api/weeks/:ws/extract-customer-file/null must never fire, because
  // there should be no preview dialog to cancel out of in the first
  // place.
  expect(deleteNullCalls).toEqual([]);

  // The row's Upload button should still be enabled (not stuck in an
  // "uploading" state) and no destructive failure toast should have
  // surfaced. The toast viewport lives at the document root.
  const uploadBtn = burnettRow.getByRole("button", {
    name: /^(Upload|Re-upload)$/,
  });
  await expect(uploadBtn).toBeEnabled();
  const destructiveToast = page
    .locator('[data-state="open"]')
    .filter({ hasText: /failed|error/i });
  await expect(destructiveToast).toHaveCount(0);
});
