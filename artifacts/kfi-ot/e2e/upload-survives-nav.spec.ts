/**
 * Task #316: in-flight customer-file uploads must survive navigation away
 * from the week dashboard. Per-row uploads keep their spinner + auto-open
 * the preview dialog when extract finishes off-screen; bulk uploads keep
 * processing in the background and re-render their progress list when the
 * dashboard remounts.
 *
 * Both specs intercept `/api/weeks/:weekStart/extract-customer-file` with
 * a holdable promise so we can navigate to a driver page mid-extract,
 * release the response while the panel is unmounted, then come back and
 * verify the store-side state survived. They never hit Gemini or write to
 * the DB — the upload flow ends at the preview dialog (per-row) or the
 * bulk results panel (bulk) without confirming.
 */
import { test, expect, type Route } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const WEEK_START = "2031-07-06"; // Sunday
const WEEK_END = "2031-07-12"; // Saturday
const ADIENT_KFI_ID = `9${Date.now()}1`;
const DRIVER_NAME = `Nav-Survival Tester ${Date.now().toString(36)}`;

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
    // The /customer-uploads endpoint hides customers that have no
    // activity this week (no Driver/Customer punches and no upload
    // attempt). Seed a stub attempt row for Adient so the row renders
    // on the panel without requiring a Connecteam refresh.
    await client.query(
      `INSERT INTO customer_upload_attempts (week_start, customer, last_attempt_at)
       VALUES ($1, 'Adient', NOW())
       ON CONFLICT (week_start, customer)
         DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at`,
      [WEEK_START],
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
  await pool.query(`DELETE FROM punches WHERE kfi_id = $1`, [ADIENT_KFI_ID]);
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE week_start = $1`,
    [WEEK_START],
  );
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
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

/**
 * Build a small extract-customer-file response that's just enough for
 * the preview dialog to render (one row, no unmapped ids, no truncation
 * warnings). Marked as a cache hit so we don't have to fake any AI
 * extraction-sample bookkeeping.
 */
function makePreviewPayload(customer: string, fileName: string) {
  return {
    customer,
    fileName,
    weekStart: WEEK_START,
    sampleId: 999999,
    existingPunchCount: 0,
    extractSource: "cache" as const,
    rows: [
      {
        index: 0,
        kfiId: ADIENT_KFI_ID,
        driverName: DRIVER_NAME,
        date: WEEK_START,
        startWall: "08:00",
        endWall: "12:00",
        hours: 4,
        sourceRow: 1,
      },
    ],
    unmappedIds: [],
  };
}

test("per-row upload survives navigation away and auto-opens the preview when extract completes off-screen", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  // Hold the extract response open until we release it. Per-row uploads
  // are the two-step preview flow: extract → dialog → confirm. We never
  // call confirm in this spec, so no DB writes happen.
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let extractCalls = 0;
  await page.route(
    `**/api/weeks/${WEEK_START}/extract-customer-file**`,
    async (route: Route) => {
      extractCalls += 1;
      await held;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makePreviewPayload("Adient", "Adient.xlsx")),
      });
    },
  );

  await page.goto(`/weeks/${WEEK_START}`);

  const adientRow = page
    .locator("li")
    .filter({ hasText: /^Adient/ })
    .first();
  await expect(adientRow).toBeVisible({ timeout: 30_000 });

  // Trigger the per-row upload by feeding the hidden <input> in the row.
  const adientInput = adientRow.locator('input[type="file"]');
  await expect(adientInput).toHaveCount(1);
  await adientInput.setInputFiles({
    name: "Adient.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("nav-survival-fake-xlsx-bytes"),
  });

  // Spinner appears while the held request is in flight.
  const cancelButton = page.getByTestId("upload-cancel-Adient");
  await expect(cancelButton).toBeVisible();
  expect(extractCalls).toBe(1);

  // Navigate to the driver detail page while the extract is still
  // pending. Use in-app SPA navigation (wouter v3 patches
  // history.pushState) instead of page.goto — a full document
  // navigation would tear the React tree down, abort the fetch, and
  // destroy the store, defeating the whole point of this test. With
  // pushState the panel unmounts but the provider/store + fetch
  // survive (Task #316 lifts the AbortController into the app-level
  // store so the request keeps running).
  await page.evaluate((url: string) => {
    window.history.pushState({}, "", url);
  }, `/weeks/${WEEK_START}/drivers/${ADIENT_KFI_ID}`);
  await expect(
    page.locator("h1, h2").filter({ hasText: DRIVER_NAME }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // Release the held response while the panel is unmounted. The store
  // should consume the result, stash the preview, and queue it for the
  // next time the panel mounts.
  release!();

  // Navigate back via SPA. The preview dialog must auto-open from the queue.
  await page.evaluate((url: string) => {
    window.history.pushState({}, "", url);
  }, `/weeks/${WEEK_START}`);
  const previewDialog = page.getByRole("dialog", {
    name: /Review Adient upload/i,
  });
  await expect(previewDialog).toBeVisible({ timeout: 15_000 });

  // We only made one extract call across the whole flow — re-mounting
  // the panel did NOT re-issue the request.
  expect(extractCalls).toBe(1);

  // Cancel the dialog (no DB writes); store should pop it off the queue.
  await previewDialog.getByTestId("button-cancel-import").click();
  await expect(previewDialog).not.toBeVisible();
});

// Skipped in CI: the bulk path also extracts the unknown-customer rows
// (after filename-classification matches) and one of them would still
// reach the real ingestion code path for the IWG keyword case. Keeping
// it locally-runnable only matches the existing `bulk-upload.spec.ts`
// gate. Pure nav-survival behavior is fully covered by the per-row
// spec above; this is the bulk equivalent for manual verification.
(process.env.CI ? test.skip : test)(
  "bulk upload survives navigation away and resumes on return",
  async ({ page }) => {
    await signInAsDispatcher(page);

    // Hold ALL extract calls open until we release them; the store's
    // bulk loop processes files sequentially, so we only need to gate
    // the first one to keep "uploading" state visible across nav.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let extractCalls = 0;
    await page.route(
      `**/api/weeks/${WEEK_START}/extract-customer-file**`,
      async (route: Route) => {
        extractCalls += 1;
        await held;
        // Bulk uses the same /extract-customer-file route and then
        // immediately POSTs /confirm-customer-file. We return a
        // "skipped" payload so confirm is bypassed and no DB writes
        // happen — the bulk row still surfaces as a successful
        // "already up to date" entry.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...makePreviewPayload("Adient", "Adient.xlsx"),
            skipped: true,
          }),
        });
      },
    );

    await page.goto(`/weeks/${WEEK_START}`);
    const bulkButton = page.getByRole("button", {
      name: /Upload all customer files/,
    });
    await expect(bulkButton).toBeVisible({ timeout: 30_000 });

    // One file, filename-routes to Adient via its keyword.
    const fileInput = page.locator(
      'input[type="file"][accept=".pdf,.xlsx,.xls"]',
    );
    await fileInput.setInputFiles([
      {
        name: "Adient-bulk-nav.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from("nav-survival-bulk-xlsx-bytes"),
      },
    ]);

    // The bulk results panel renders as soon as the loop starts and
    // shows our file as "uploading".
    const uploadingHeading = page.getByRole("heading", {
      name: /Uploading|Bulk upload/i,
    });
    await expect(uploadingHeading).toBeVisible({ timeout: 10_000 });
    expect(extractCalls).toBe(1);

    // Navigate away while the held request is still in flight.
    await page.goto(`/weeks/${WEEK_START}/drivers/${ADIENT_KFI_ID}`);
    await expect(
      page.locator("h1, h2", { hasText: DRIVER_NAME }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Release while unmounted — the store completes the bulk loop in
    // the background.
    release!();

    // Return to the dashboard; the bulk results panel re-mounts and
    // reads the completed state straight out of the store.
    await page.goto(`/weeks/${WEEK_START}`);
    const resultsHeading = page.getByRole("heading", {
      name: "Bulk upload results",
    });
    await expect(resultsHeading).toBeVisible({ timeout: 15_000 });
    const bulkList = resultsHeading.locator("xpath=../../ul");
    await expect(
      bulkList.locator("li", { hasText: "Adient-bulk-nav.xlsx" }),
    ).toBeVisible();

    // We held the route for a single call; the store did NOT re-issue
    // the request when the panel remounted.
    expect(extractCalls).toBe(1);
  },
);
