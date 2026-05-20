/**
 * End-to-end coverage for the Cancel button next to an in-flight per-row
 * customer-file upload (task #317).
 *
 * Before the fix, clicking Cancel aborted the fetch but left the row
 * stuck in `uploading: true` because `cancelRowUpload` deleted the
 * in-flight controller from `rowAborts.current` before the catch/finally
 * block ran — so the handler's stale-controller guard
 * (`rowAborts.current[customer] === controller`) was already false and
 * the cleanup `setRow(..., { uploading: false, ... })` got skipped.
 *
 * The fix moves that state cleanup into `cancelRowUpload` itself, so
 * the spinner / elapsed badge / cancel button all disappear immediately.
 *
 * The test stubs `/extract-customer-file` so the request hangs
 * indefinitely (we never call route.fulfill) — that gives us a
 * deterministic in-flight window to click Cancel.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const WEEK_START = "2031-06-01";
const WEEK_END = "2031-06-07";

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
  // Seed an upload-attempt row so the Adient (known-customer) row is
  // rendered in the customer-files panel — without prior activity the
  // panel hides the row and there is no file input to trigger.
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

test("clicking Cancel on an in-flight row upload clears the spinner immediately", async ({
  page,
}) => {
  // Hang the extract request indefinitely so the row stays in its
  // "uploading" state until we click Cancel. The route handler never
  // calls fulfill/continue — Playwright will tear it down with the
  // browser context at end-of-test.
  let extractCalls = 0;
  await page.route("**/api/weeks/*/extract-customer-file**", async () => {
    extractCalls++;
    // Hold the request open forever (within the test lifetime).
    await new Promise<void>(() => {});
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
  await adientInput.setInputFiles({
    name: "Adient-cancel-stub.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a real xlsx"),
  });

  // The cancel button is only rendered while the row is uploading, so
  // its appearance is our "upload is in flight" signal.
  const cancelBtn = adientRow.getByTestId("upload-cancel-Adient");
  await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
  // Sanity: the route really was hit (so we know we're canceling a real
  // in-flight request, not a phantom state).
  expect(extractCalls).toBeGreaterThanOrEqual(1);

  await cancelBtn.click();

  // Row returns to idle: cancel button disappears and Upload becomes
  // clickable again (no longer disabled).
  await expect(cancelBtn).toBeHidden({ timeout: 5_000 });
  const uploadBtn = adientRow.getByRole("button", { name: /^(Upload|Re-upload)$/ });
  await expect(uploadBtn).toBeEnabled();

  // No destructive toast for a user-initiated cancel. shadcn's toast
  // viewport lives at the document root, not inside the row.
  const destructiveToast = page.locator('[data-state="open"][role="status"]').filter({
    hasText: /failed|error/i,
  });
  await expect(destructiveToast).toHaveCount(0);

  // Starting a fresh upload on the same row immediately afterwards
  // works — i.e. cancel didn't leave any leftover state that blocks the
  // next attempt. The hang-stub still applies, so we just need to see
  // the cancel button reappear.
  await adientInput.setInputFiles({
    name: "Adient-cancel-stub-2.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a real xlsx either"),
  });
  await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
  expect(extractCalls).toBeGreaterThanOrEqual(2);

  // Tidy: cancel the second in-flight upload before the test ends so the
  // hanging route handler doesn't leak into teardown.
  await cancelBtn.click();
  await expect(cancelBtn).toBeHidden({ timeout: 5_000 });
});
