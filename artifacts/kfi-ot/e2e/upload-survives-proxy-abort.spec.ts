/**
 * Task #369 — customer-file upload survives the Replit proxy's 5-minute
 * (299999ms) response cap.
 *
 * Big AI extracts (Adient: 71 chunks, ~6 min) finish on the server
 * but the proxy kills the POST socket at exactly 5 minutes. The
 * route now stashes its terminal `res.json(...)` body into the
 * `extractProgress` result store; the client falls back to polling
 * `GET .../extract-progress/:progressKey` and picks up the persisted
 * preview when the POST rejects with a network error.
 *
 * This spec exercises both halves end-to-end against a stubbed
 * extract POST (no Gemini / Claude, no DB writes — the flow stops at
 * the preview dialog which the dispatcher would normally confirm).
 *
 *   1. Same-tab recovery: the POST is held forever, then the route
 *      is fulfilled with a `NS_ERROR_NET_RESET`-style network failure
 *      to simulate the proxy cap. The progress endpoint is stubbed
 *      to return `{ status: "succeeded", result: <preview> }` and the
 *      panel must open the preview dialog without surfacing an
 *      "Upload failed" toast.
 *   2. Reload recovery: the panel is unmounted via a full
 *      `page.reload()` while the (stubbed) extract is in-flight; the
 *      remounted panel reads the `progressKey` back out of
 *      sessionStorage and resumes polling, then opens the preview.
 *
 * We never call /confirm-customer-file so no rows hit the DB. The
 * stub also keeps Gemini/Claude completely out of the path — the
 * server's real extract code never runs.
 */
import { test, expect, type Route } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const WEEK_START = "2031-08-03"; // Sunday
const WEEK_END = "2031-08-09"; // Saturday
const ADIENT_KFI_ID = `8${Date.now()}1`;
const DRIVER_NAME = `Proxy-Cap Tester ${Date.now().toString(36)}`;

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
    // activity this week; seed a stub attempt so the Adient row
    // renders without a Connecteam refresh.
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

function previewPayload() {
  return {
    customer: "Adient",
    fileName: "Adient.xlsx",
    weekStart: WEEK_START,
    sampleId: 888888,
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

test("per-row upload recovers when the proxy aborts the extract POST mid-flight", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  // The extract POST never resolves successfully — we abort it with a
  // network error to simulate the Replit proxy's 5-minute cap killing
  // the socket. The handler's terminal `res.json(...)` would normally
  // have published the preview into the result store; we mimic that
  // by returning it from the stubbed extract-progress endpoint below.
  let extractCalls = 0;
  await page.route(
    `**/api/weeks/${WEEK_START}/extract-customer-file**`,
    async (route: Route) => {
      extractCalls += 1;
      // `abort('failed')` makes the client-side fetch reject with a
      // TypeError, mirroring what the browser sees when the proxy
      // resets the socket.
      await route.abort("failed");
    },
  );

  // Progress endpoint stub: serve "running" until we flip the flag,
  // then serve the stashed succeeded result. The panel's
  // `waitForExtractResult` polls this URL once it sees the POST
  // reject.
  let serveResult = false;
  let progressCalls = 0;
  await page.route(
    `**/api/weeks/${WEEK_START}/extract-progress/**`,
    async (route: Route) => {
      progressCalls += 1;
      if (!serveResult) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "running",
            current: 35,
            total: 71,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "succeeded",
          httpStatus: 200,
          result: previewPayload(),
        }),
      });
    },
  );

  await page.goto(`/weeks/${WEEK_START}`);
  const adientRow = page
    .locator("li")
    .filter({ hasText: /^Adient/ })
    .first();
  await expect(adientRow).toBeVisible({ timeout: 30_000 });

  const adientInput = adientRow.locator('input[type="file"]');
  await expect(adientInput).toHaveCount(1);
  await adientInput.setInputFiles({
    name: "Adient.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("proxy-cap-fake-xlsx-bytes"),
  });

  // POST kicks off and is immediately aborted; the panel must NOT
  // show "Upload failed" yet — it's still polling for the stashed
  // result.
  await expect.poll(() => extractCalls).toBe(1);
  await expect.poll(() => progressCalls, { timeout: 15_000 }).toBeGreaterThan(0);

  // Flip the stub: the server "stashed" its terminal preview body.
  serveResult = true;

  // The preview dialog auto-opens once the poll picks up the result.
  const previewDialog = page.getByRole("dialog", {
    name: /Review Adient upload/i,
  });
  await expect(previewDialog).toBeVisible({ timeout: 15_000 });

  // We did NOT retry the POST — the recovery path goes through the
  // GET endpoint only.
  expect(extractCalls).toBe(1);

  await previewDialog.getByTestId("button-cancel-import").click();
  await expect(previewDialog).not.toBeVisible();
});

test("reload mid-extract reattaches via sessionStorage and opens the preview", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  // Same setup as the previous spec — the POST gets aborted, the
  // progress endpoint flips from "running" to "succeeded". The twist
  // is that we reload the page after kicking off the upload; the
  // remounted panel must read the progressKey back out of
  // sessionStorage and resume polling.
  await page.route(
    `**/api/weeks/${WEEK_START}/extract-customer-file**`,
    async (route: Route) => {
      await route.abort("failed");
    },
  );

  let serveResult = false;
  await page.route(
    `**/api/weeks/${WEEK_START}/extract-progress/**`,
    async (route: Route) => {
      if (!serveResult) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "running",
            current: 10,
            total: 71,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "succeeded",
          httpStatus: 200,
          result: previewPayload(),
        }),
      });
    },
  );

  await page.goto(`/weeks/${WEEK_START}`);
  const adientRow = page
    .locator("li")
    .filter({ hasText: /^Adient/ })
    .first();
  await expect(adientRow).toBeVisible({ timeout: 30_000 });

  const adientInput = adientRow.locator('input[type="file"]');
  await adientInput.setInputFiles({
    name: "Adient.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("proxy-cap-fake-xlsx-bytes"),
  });

  // Wait long enough for the panel to persist the in-flight entry to
  // sessionStorage before the reload tears the React tree down.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          for (let i = 0; i < window.sessionStorage.length; i++) {
            const k = window.sessionStorage.key(i);
            if (k && k.startsWith("kfi-ot:extract-in-flight:")) return true;
          }
          return false;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);

  // Full reload — sessionStorage survives, React state does not.
  await page.reload();
  await expect(adientRow).toBeVisible({ timeout: 30_000 });

  // Server now "finishes" the extract.
  serveResult = true;

  const previewDialog = page.getByRole("dialog", {
    name: /Review Adient upload/i,
  });
  await expect(previewDialog).toBeVisible({ timeout: 15_000 });

  await previewDialog.getByTestId("button-cancel-import").click();
  await expect(previewDialog).not.toBeVisible();
});
