/**
 * Task #385 — UI-level regression guard for the bulk-upload loop's
 * cancel control. The bulk loop in `runBulk`
 * (`artifacts/kfi-ot/src/components/customer-upload-panel.tsx`) wires
 * each per-file `doUpload` call to a per-week single-flight
 * `AbortController` (`bulkAbortRef`). The "Stop" button rendered in the
 * bulk-results header while `bulkRunning` is true aborts that
 * controller, which both kills the in-flight /extract or /confirm fetch
 * and breaks out of the queue so remaining pending files don't keep
 * uploading.
 *
 * Without coverage, a future refactor could easily detach the button
 * from the controller — the queue would keep marching, the dispatcher
 * would think they stopped a runaway batch, and every remaining file
 * would still hit the AI extractor.
 *
 * Strategy mirrors `bulk-upload-skipped-toast.spec.ts` (#384):
 *   - Mock the `/extract-customer-file` (and the follow-up
 *     `/confirm-customer-file`) responses with `page.route()` so we
 *     get a deterministic window to click "Stop" between files.
 *   - The first file's extract resolves immediately so the loop moves
 *     to file #2.
 *   - The second file's extract is stalled by holding the route
 *     callback — that's the window we click "Stop" in. The handler
 *     then waits for the abort signal and rejects the request, which
 *     bubbles back as an aborted fetch.
 *   - Assert: file #1 is "success", file #2 + file #3 are "pending"
 *     (the cancel handler rolls the in-flight item back to pending and
 *     never starts file #3). The third file's extract endpoint must
 *     never be called after the cancel.
 */
import { test, expect, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const WEEK_START = "2031-08-10"; // Sunday — distinct from #384's week
const WEEK_END = "2031-08-16"; // Saturday
// Must match the seeded `customers.displayName` so the
// /weeks/:ws/customer-uploads response (which drives classifyFile in
// the panel) routes a "burnett"-keyword filename to this row.
const CUSTOMER = "Burnett Dairy-Grantsburg";
const DRIVER = {
  kfiId: `9${Date.now()}`,
  name: "Bulk Cancel Tester",
  customer: CUSTOMER,
};

const here = path.dirname(fileURLToPath(import.meta.url));
// Reused fixture — bytes are irrelevant because we mock both endpoints,
// but a real Burnett xlsx keeps mimetype + extension realistic so the
// picker's accept-filter and the panel's classifier behave exactly like
// a dispatcher drop.
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
  // /weeks/:ws/customer-uploads filters known customers through
  // `hasActivityThisWeek` — a customer only appears (with its
  // `keywords`) when there's at least one driver/customer punch or
  // upload attempt for the week. classifyFile in the panel reads
  // `keywords` to route the dropped file, so seed a benign
  // upload-attempt row.
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

test("the bulk-upload 'Stop' button aborts the loop and leaves remaining files in pending status (#385)", async ({
  page,
}) => {
  let extractCount = 0;
  let confirmCount = 0;
  // Used to assert no extract POST fires for file #3 after cancel.
  let extractCountAtCancel = 0;
  // Captured route for file #2 so the test can release it after
  // clicking Stop — the response itself is irrelevant because the
  // abort signal aborts the underlying fetch, but we still need to
  // free the Playwright route handler so the request resolves.
  let stallRelease: (() => void) | null = null;

  await page.route(
    /\/api\/weeks\/[^/]+\/extract-customer-file(\?|$)/,
    async (route: Route) => {
      extractCount++;
      const idx = extractCount;
      if (idx === 1) {
        // First file: respond immediately with a real preview the
        // panel will auto-confirm so the loop advances to file #2.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            customer: CUSTOMER,
            fileName: "Burnett_G.xlsx",
            weekStart: WEEK_START,
            sampleId: "sample-bulk-cancel-e2e",
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
      // File #2: stall until the test releases us. The `abort` signal
      // from the panel's `bulkAbortRef` is what actually unblocks
      // doUpload — we mirror that by waiting for `stallRelease` (the
      // test calls it right after clicking Stop) and then aborting
      // the route so the in-browser fetch rejects with an
      // AbortError-style failure (`net::ERR_FAILED`), exactly like a
      // real aborted upload would.
      await new Promise<void>((resolve) => {
        stallRelease = resolve;
      });
      await route.abort("failed");
    },
  );
  await page.route(
    /\/api\/weeks\/[^/]+\/confirm-customer-file(\?|$)/,
    async (route: Route) => {
      confirmCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ punchesUpserted: 1, unmappedIds: [] }),
      });
    },
  );

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`);

  // Wait for the customer-files panel so the bulk <input> is mounted.
  // The bulk header buttons are feature-flagged off
  // (`SHOW_BULK_UPLOAD_BUTTONS = false`) but the hidden `<input
  // multiple>` is always present and its onChange invokes `runBulk`
  // directly — drive it ourselves instead of clicking a button that
  // may not be visible.
  await expect(
    page.getByRole("heading", { level: 3, name: "Customer files" }),
  ).toBeVisible({ timeout: 30_000 });

  // The panel has two hidden multi-file inputs; the bulk one carries
  // `accept` and not `webkitdirectory`.
  const fileInput = page.locator(
    'input[type="file"][accept][multiple]:not([webkitdirectory])',
  );
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles([
    {
      name: "Burnett_G_1.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: FIXTURE_BYTES,
    },
    {
      name: "Burnett_G_2.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: FIXTURE_BYTES,
    },
    {
      name: "Burnett_G_3.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: FIXTURE_BYTES,
    },
  ]);

  // File #1 should finish (success row) and file #2 should be the one
  // sitting at "uploading" while the stalled extract route blocks it.
  const firstItem = page.locator('[data-testid="bulk-item-0"]');
  const secondItem = page.locator('[data-testid="bulk-item-1"]');
  const thirdItem = page.locator('[data-testid="bulk-item-2"]');
  await expect(firstItem).toHaveAttribute("data-status", "success", {
    timeout: 15_000,
  });
  await expect(secondItem).toHaveAttribute("data-status", "uploading", {
    timeout: 15_000,
  });
  // File #3 hasn't started yet — still pending.
  await expect(thirdItem).toHaveAttribute("data-status", "pending");

  // Click the Stop button while bulkRunning is true.
  const cancelBtn = page.getByTestId("button-cancel-bulk");
  await expect(cancelBtn).toBeVisible();
  extractCountAtCancel = extractCount;
  await cancelBtn.click();

  // Release the stalled extract so the route handler can finish (the
  // abort would otherwise leave the route stuck once the test ends).
  // The browser-side fetch is already aborted by the panel's
  // AbortController, so this `route.abort("failed")` just unblocks
  // Playwright's internal queue — it doesn't affect the assertion
  // below.
  expect(stallRelease).not.toBeNull();
  stallRelease?.();

  // After cancel, the in-flight item should roll back to pending and
  // file #3 should stay pending (loop broke before it ran). Wait for
  // bulkRunning to settle by checking the dismiss button reappears
  // (it only renders when !bulkRunning) — that's our cue the loop
  // exited.
  await expect(cancelBtn).toBeHidden({ timeout: 10_000 });
  await expect(secondItem).toHaveAttribute("data-status", "pending");
  await expect(thirdItem).toHaveAttribute("data-status", "pending");
  // File #1 stays a success.
  await expect(firstItem).toHaveAttribute("data-status", "success");

  // Cancellation toast confirms the dispatcher's action.
  await expect(
    page.getByText(/Bulk upload canceled/i).first(),
  ).toBeVisible({ timeout: 10_000 });

  // The real regression guard: no further extract POST fires for
  // file #3 after cancel. extractCount should equal what it was at
  // cancel time (the in-flight #2 already counted). If the future
  // refactor in the task description ever quietly disconnects the
  // Stop button from the AbortController, extractCount would climb
  // to 3 here.
  // Give the event loop one tick to flush any rogue queued fetches
  // before locking in the assertion.
  await page.waitForTimeout(250);
  expect(extractCount).toBe(extractCountAtCancel);
  // Confirm only fired for the first (successful) upload.
  expect(confirmCount).toBe(1);
});
