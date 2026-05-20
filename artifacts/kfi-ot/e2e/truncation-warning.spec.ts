/**
 * End-to-end coverage for the truncation-warning banner
 * (`[data-testid=text-truncated-warning]`).
 *
 * Task #264 wired `extractionTruncated` from the backend into both
 * preview dialogs (known-customer `CustomerPreviewDialog` and AI
 * `NewCustomerDialog`) so a dispatcher knows when Gemini hit the
 * output-token cap and rows are likely missing. Without UI coverage a
 * future refactor could silently drop that banner — at which point a
 * dispatcher could confirm a truncated import and short-pay drivers.
 *
 * Both halves stub the relevant extract endpoint via `page.route` so
 * we never touch Gemini in CI — the warning is a pure render of a
 * server-supplied boolean, so the stub is sufficient and deterministic.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const WEEK_START = "2031-05-04";
const WEEK_END = "2031-05-10";

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE week_start = $1 AND customer = 'Adient'`,
    [WEEK_START],
  );
}

test.beforeAll(async () => {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await cleanup();
  // The dashboard's /customer-uploads endpoint only renders a known-customer
  // row when there is some activity for that (week, customer). Seed an
  // upload-attempt row so the Adient (KNOWN_CUSTOMERS) row is present —
  // without it the panel is empty and there's no file input to trigger.
  await pool.query(
    `INSERT INTO customer_upload_attempts
       (week_start, customer, last_attempt_at)
     VALUES ($1, 'Adient', now())
     ON CONFLICT (week_start, customer) DO UPDATE
       SET last_attempt_at = EXCLUDED.last_attempt_at`,
    [WEEK_START],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("customer-preview dialog renders the truncation warning when the backend reports it", async ({
  page,
}) => {
  await page.route("**/api/weeks/*/extract-customer-file**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        customer: "Adient",
        fileName: "Adient-stub.xlsx",
        weekStart: WEEK_START,
        sampleId: 99999,
        rows: [],
        unmappedIds: [],
        existingPunchCount: 0,
        extractSource: "ai",
        cacheWritten: false,
        extractionTruncated: true,
      }),
    });
  });

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`, { waitUntil: "commit" });

  const adientRow = page
    .locator("li")
    .filter({ hasText: /^Adient/ })
    .first();
  await expect(adientRow).toBeVisible({ timeout: 30_000 });

  const adientInput = adientRow.locator('input[type="file"]');
  await expect(adientInput).toHaveCount(1);
  // The route is stubbed, so the bytes don't matter — only the filename
  // (xlsx) so the input's `accept` filter is happy.
  await adientInput.setInputFiles({
    name: "Adient-stub.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a real xlsx"),
  });

  const previewDialog = page.getByRole("dialog", {
    name: /Review Adient upload/i,
  });
  await expect(previewDialog).toBeVisible({ timeout: 15_000 });
  await expect(
    previewDialog.getByTestId("text-truncated-warning"),
  ).toBeVisible();
});

// Skipped: the "New customer file…" button this test clicks is gated behind
// `SHOW_BULK_UPLOAD_BUTTONS = false` in customer-upload-panel.tsx, so the
// header entry-point no longer exists in the rendered DOM. The truncation-
// warning behaviour itself is still covered by the known-customer test
// above; re-enable when the bulk-upload controls are reintroduced.
test.skip("new-customer dialog renders the truncation warning when the backend reports it", async ({
  page,
}) => {
  await page.route("**/api/weeks/*/extract-new-customer**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        customer: "Truncation Test Co",
        weekStart: WEEK_START,
        rows: [],
        suggestions: [],
        sampleId: 99998,
        extractionTruncated: true,
      }),
    });
  });

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`, { waitUntil: "commit" });

  // Wait for the customer-files panel to render before clicking the
  // "New customer file…" button (it lives in the same panel header).
  await expect(
    page
      .locator("li")
      .filter({ hasText: /^Adient/ })
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /New customer file/i }).click();

  const dialog = page.getByRole("dialog", {
    name: /New customer file/i,
  });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel(/Customer name/i).fill("Truncation Test Co");
  await dialog.locator("#ncf-file").setInputFiles({
    name: "truncation-stub.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a real xlsx"),
  });

  await dialog.getByRole("button", { name: /Extract with AI/i }).click();

  await expect(dialog.getByTestId("text-truncated-warning")).toBeVisible({
    timeout: 15_000,
  });
});
