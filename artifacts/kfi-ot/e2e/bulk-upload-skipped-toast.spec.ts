/**
 * Task #384 — UI-level regression guard for the bulk-upload flow's
 * translation of a server `{ skipped: true }` response into a bulk-results
 * row + summary toast count.
 *
 * Sibling spec to `per-row-reupload-skipped-toast.spec.ts` (#382), which
 * covered the per-row picker / drag-on-row code path. The bulk picker
 * runs through a different branch — `runBulk` (in
 * `components/customer-upload-panel.tsx`)
 * calls `doUpload` / `doOneShot`, which interprets `{ skipped: true }` as
 * a `BulkItem` with `status: "skipped"` and increments the `skipped`
 * counter in the rollup toast description.
 *
 * Why mock the network instead of seeding `customer_upload_attempts` and
 * letting the server return skipped: the bulk loop always sends
 * `?force=1` (see `runBulk` in customer-upload-panel.tsx ~line 1036 and
 * the matching hook implementation), and the server's same-bytes
 * short-circuit only fires when force is unset
 * (`artifacts/api-server/src/routes/weeks.ts` ~line 1918). So in
 * production the only way bulk hits the skipped branch today is if the
 * server starts returning skipped under force too — which is exactly the
 * future refactor the task is trying to keep safe. Mocking the extract
 * response pins the *client-side* contract regardless of when/how the
 * server happens to issue the skip.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const WEEK_START = "2031-08-03"; // Sunday
const WEEK_END = "2031-08-09"; // Saturday
// Must match the seeded `customers.displayName` so the
// /weeks/:ws/customer-uploads response (which drives classifyFile in the
// panel) routes a "burnett"-keyword filename to this row.
const CUSTOMER = "Burnett Dairy-Grantsburg";
const DRIVER = {
  kfiId: `9${Date.now()}`,
  name: "Bulk Skip Tester",
  customer: CUSTOMER,
};

const here = path.dirname(fileURLToPath(import.meta.url));
// Reused fixture (per the task — no new fixtures); the actual bytes are
// irrelevant because we mock the extract response, but using a real
// Burnett xlsx keeps the mimetype + extension realistic so the picker's
// accept-filter and the panel's classifier behave identically to a real
// dispatcher drop.
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

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, CUSTOMER],
  );
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, CUSTOMER],
  );
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [DRIVER.kfiId]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
}

test.beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO UPDATE
       SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
    [DRIVER.kfiId, DRIVER.name, DRIVER.customer],
  );
  // The /weeks/:ws/customer-uploads endpoint filters known customers
  // through `hasActivityThisWeek` — a customer only appears (with its
  // `keywords`) when there's a driver-source punch, customer-source
  // punch, or upload attempt for the week. classifyFile in the panel
  // reads `keywords` to route the dropped file. Seed a benign
  // upload-attempt row so Burnett's keywords reach the client.
  await pool.query(
    `INSERT INTO customer_upload_attempts
       (week_start, customer, last_attempt_at)
     VALUES ($1, $2, now())
     ON CONFLICT (week_start, customer) DO UPDATE
       SET last_attempt_at = EXCLUDED.last_attempt_at`,
    [WEEK_START, CUSTOMER],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("bulk-upload with a same-bytes duplicate surfaces a 'skipped' row + 'skipped' segment in the summary toast (#384)", async ({
  page,
}) => {
  // Mock the two endpoints the bulk loop drives. First extract = a real
  // preview the panel auto-confirms; second extract = the skipped shape
  // that the bug-prone branch translates to a `status: "skipped"` row.
  let extractCount = 0;
  await page.route(
    /\/api\/weeks\/[^/]+\/extract-customer-file(\?|$)/,
    async (route) => {
      extractCount++;
      if (extractCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            customer: CUSTOMER,
            fileName: "Burnett_G.xlsx",
            weekStart: WEEK_START,
            sampleId: "sample-bulk-skip-e2e",
            rows: [
              {
                kfiId: DRIVER.kfiId,
                driverName: DRIVER.name,
                dateLocal: WEEK_START,
                startLocal: `${WEEK_START}T08:00:00`,
                endLocal: `${WEEK_START}T12:00:00`,
                hours: 4,
                keep: true,
              },
            ],
            unmappedIds: [],
            existingPunchCount: 0,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          customer: CUSTOMER,
          fileName: "Burnett_G.xlsx",
          weekStart: WEEK_START,
          sampleId: null,
          rows: [],
          unmappedIds: [],
          existingPunchCount: 0,
          skipped: true,
        }),
      });
    },
  );
  await page.route(
    /\/api\/weeks\/[^/]+\/confirm-customer-file(\?|$)/,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ punchesUpserted: 1, unmappedIds: [] }),
      });
    },
  );

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`);

  // The bulk header buttons are currently feature-flagged off
  // (`SHOW_BULK_UPLOAD_BUTTONS = false` in customer-upload-panel.tsx) but
  // the hidden `<input multiple>` that drives the bulk loop is always
  // mounted and its onChange invokes `runBulk(files)` directly. So we
  // drive the input ourselves instead of clicking a button that may not
  // be visible. We still wait for the customer-uploads panel to mount
  // (its heading) so the input is in the DOM.
  await expect(
    page.getByRole("heading", { level: 3, name: "Customer files" }),
  ).toBeVisible({ timeout: 30_000 });

  // Locate the bulk input resiliently: the panel has two hidden multi-
  // file inputs — the bulk one carries an `accept` attribute
  // (UNIVERSAL_ACCEPT) while the folder picker carries `webkitdirectory`
  // and no `accept`. `[accept][multiple]:not([webkitdirectory])` matches
  // the bulk input regardless of how the accept list expands in the
  // future.
  const fileInput = page.locator(
    'input[type="file"][accept][multiple]:not([webkitdirectory])',
  );
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles([
    {
      name: "Burnett_G.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: FIXTURE_BYTES,
    },
    {
      name: "Burnett_G.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: FIXTURE_BYTES,
    },
  ]);

  const resultsHeading = page.getByRole("heading", {
    name: "Bulk upload results",
  });
  await expect(resultsHeading).toBeVisible({ timeout: 30_000 });

  // Row 0 → success (first preview auto-confirmed).
  // Row 1 → skipped (the {skipped: true} translation under test).
  const firstItem = page.locator('[data-testid="bulk-item-0"]');
  const secondItem = page.locator('[data-testid="bulk-item-1"]');
  await expect(firstItem).toHaveAttribute("data-status", "success", {
    timeout: 15_000,
  });
  await expect(secondItem).toHaveAttribute("data-status", "skipped", {
    timeout: 15_000,
  });
  // The "Already up to date" caption is the user-visible "skipped" pill.
  await expect(secondItem).toContainText("Already up to date");

  // Rollup toast format (see runBulk in customer-upload-panel.tsx ~1076
  // and the matching hook): `"{n} uploaded, {n} skipped, {n} failed."`.
  // The "{n} skipped" segment is the regression guard — it's only
  // emitted when the bulk loop counted at least one `r.skipped` result.
  await expect(
    page
      .getByText("1 uploaded, 1 skipped, 0 failed.", { exact: true })
      .first(),
  ).toBeVisible({ timeout: 15_000 });

  // Sanity: both files made it to the extract endpoint (proves the
  // panel didn't dedupe client-side and quietly drop the second drop).
  expect(extractCount).toBe(2);
});
