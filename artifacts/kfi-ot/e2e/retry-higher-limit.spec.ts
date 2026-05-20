/**
 * Task #356 — Retry-with-higher-limit e2e.
 *
 * When a customer-file extract aborts with `IngestionBudgetExceeded`
 * (the per-upload AI call cap from Task #297), the failing row in the
 * customer-files panel must surface an admin-only "Retry with higher
 * limit" button. Clicking it re-submits the same file with
 * `?maxCalls=200` so the second attempt authorizes more AI calls and
 * lands on the preview dialog.
 *
 * The test stubs `/extract-customer-file` so the first request returns
 * the canonical IngestionBudgetExceeded 400 response, and the second
 * request (the retry, identified by `?maxCalls=200` in the URL) returns
 * a small successful preview payload. The Adient row is used because
 * the panel only renders rows that already have either punches or a
 * recorded upload attempt — we seed the attempt row in beforeAll.
 *
 * Surfaces under test:
 *   - `customer-upload-panel.tsx` capExceeded detection in extractFor
 *     and the admin-gated "Retry with higher limit" button render.
 *   - The `?maxCalls=` query-string wiring on the retry path.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the retry-higher-limit e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-06-08"; // Sunday
const WEEK_END = "2031-06-14"; // Saturday

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE week_start = $1 AND customer = 'Adient'`,
    [WEEK_START],
  );
  await pool.query(
    `DELETE FROM user_audit_log
       WHERE action = 'customer-upload-cap-override'
         AND target_email LIKE $1`,
    [`cap-override:Adient:${WEEK_START}:%`],
  );
}

test.beforeAll(async () => {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await cleanup();
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

test("admin can retry a budget-exceeded extract with a higher AI call limit", async ({
  page,
}) => {
  const callUrls: string[] = [];
  await page.route(
    "**/api/weeks/*/extract-customer-file*",
    async (route, request) => {
      callUrls.push(request.url());
      if (request.url().includes("maxCalls=200")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            customer: "Adient",
            startDate: WEEK_START,
            endDate: WEEK_END,
            rows: [],
            unmappedIds: [],
            sampleId: "retry-stub",
            isAiImported: true,
            ai: {
              provider: "claude",
              modelCalls: 1,
              fallbackUsed: false,
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            "AI extraction stopped: this upload would exceed the per-file safety limit of 95 model calls (currently 96). Split the file into smaller pieces, or contact an admin to raise the cap.",
        }),
      });
    },
  );

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`, { waitUntil: "commit" });

  const adientRow = page
    .locator("li")
    .filter({ hasText: /^Adient/ })
    .first();
  await expect(adientRow).toBeVisible({ timeout: 30_000 });

  const adientInput = adientRow.locator('input[type="file"]');
  await expect(adientInput).toHaveCount(1);
  await adientInput.setInputFiles({
    name: "Adient-huge.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a real xlsx"),
  });

  const retryBtn = adientRow.getByTestId("button-retry-higher-limit-Adient");
  await expect(retryBtn).toBeVisible({ timeout: 10_000 });
  // Sanity: first call landed on the bare URL with no maxCalls override.
  expect(callUrls.some((u) => !u.includes("maxCalls="))).toBe(true);

  await retryBtn.click();

  // Retry call hits the server with maxCalls=200.
  await expect
    .poll(() => callUrls.filter((u) => u.includes("maxCalls=200")).length, {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(1);
});
