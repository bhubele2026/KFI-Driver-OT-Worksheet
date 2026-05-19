/**
 * End-to-end coverage for Task #137: click-to-review bubbles in the drivers
 * sidebar plus the "all reviewed" confetti+splash transition.
 *
 * Covers:
 *   1. Clicking a driver's bubble toggles reviewed without navigating away.
 *   2. Clicking the bubble of a "bad"-flagged driver is a no-op (does not
 *      flip the reviewed state and does not show the splash).
 *   3. Toggling the last unreviewed driver shows the all-reviewed splash.
 *   4. Reloading a fully-reviewed week does not re-show the splash.
 *
 * Auto-advance is disabled so toggling the currently-selected driver does
 * not navigate away mid-test.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the all-reviewed-celebration e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-05-05";
const WEEK_END = "2031-05-11";
const SUFFIX = `e2e-arc-${Date.now().toString(36)}`;
const DRIVERS = [
  { kfiId: `KFI-AR1-${SUFFIX}`, name: "AAA Celebrate One", customer: "Adient" },
  { kfiId: `KFI-AR2-${SUFFIX}`, name: "BBB Celebrate Two", customer: "Adient" },
  { kfiId: `KFI-AR3-${SUFFIX}`, name: "CCC Celebrate Three", customer: "Adient" },
] as const;

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
       ON CONFLICT (start_date) DO NOTHING`,
      [WEEK_START, WEEK_END],
    );
    for (const d of DRIVERS) {
      await client.query(
        `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
         ON CONFLICT (kfi_id) DO UPDATE
           SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
        [d.kfiId, d.name, d.customer],
      );
      await client.query(
        `INSERT INTO punches
           (week_start, kfi_id, customer, source, date,
            clock_in, clock_out, hours, is_manual)
         VALUES ($1::date, $2, $3, 'Driver', $4,
                 $5, $6, 4.0, true)`,
        [
          WEEK_START,
          d.kfiId,
          d.customer,
          WEEK_START,
          `${WEEK_START} 8:00 AM`,
          `${WEEK_START} 12:00 PM`,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  const ids = DRIVERS.map((d) => d.kfiId);
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`, [ids]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("kfi-ot:auto-advance-reviewed:v1", "0");
    } catch {
      /* ignore */
    }
  });
});

test("bubble click toggles reviewed without navigating, bad is a no-op, and last toggle triggers splash that does not re-show on reload", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`);
  await expect(
    page.getByRole("heading", { name: DRIVERS[0].name }),
  ).toBeVisible();
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();

  const pill = page.getByTestId("pill-reviewed-progress");
  const bubble1 = page.getByTestId(`sidebar-bubble-${DRIVERS[0].kfiId}`);
  const bubble2 = page.getByTestId(`sidebar-bubble-${DRIVERS[1].kfiId}`);
  const bubble3 = page.getByTestId(`sidebar-bubble-${DRIVERS[2].kfiId}`);
  const row1 = page.getByTestId(`sidebar-driver-${DRIVERS[0].kfiId}`);
  const splash = page.getByTestId("all-reviewed-splash");

  // Baseline: nothing reviewed, no splash.
  await expect(pill).toHaveText("0 / 3 reviewed");
  await expect(splash).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(
    `/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`,
  );

  // 1. Click the bubble for driver 1. It should flip reviewed but NOT
  //    navigate (we're already on driver 1) — verify the bubble icon and
  //    pill update, and that the URL is unchanged.
  await bubble1.click();
  await expect(pill).toHaveText("1 / 3 reviewed");
  await expect(
    row1.locator("svg.text-emerald-600, svg.text-emerald-400"),
  ).toHaveCount(1);
  expect(new URL(page.url()).pathname).toBe(
    `/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`,
  );

  // 2. Click bubble for driver 2 (different from current driver). The
  //    bubble's stopPropagation must keep the row click from navigating.
  await bubble2.click();
  await expect(pill).toHaveText("2 / 3 reviewed");
  expect(new URL(page.url()).pathname).toBe(
    `/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`,
  );

  // 3. Mark driver 1 "bad" server-side, reload, and verify the bubble is
  //    disabled (clicking it does not change pill or show splash).
  await pool.query(
    `INSERT INTO reviewed_drivers (week_start, kfi_id, status)
     VALUES ($1::date, $2, 'bad')
     ON CONFLICT (week_start, kfi_id) DO UPDATE SET status = 'bad'`,
    [WEEK_START, DRIVERS[0].kfiId],
  );
  await page.reload();
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();
  // After reload the seenAllReviewed map is wiped, but we're not all
  // reviewed (driver 3 is still unreviewed and driver 1 is bad/not
  // reviewed), so the splash must not appear from initialization.
  await expect(splash).toHaveCount(0);
  await expect(
    page.getByTestId(`sidebar-status-bad-${DRIVERS[0].kfiId}`),
  ).toBeVisible();
  await expect(bubble1).toBeDisabled();
  await expect(splash).toHaveCount(0);

  // 4. Clear "bad" so we can fully review the week. Mark driver 1 reviewed
  //    again, then driver 3. Toggling the LAST unreviewed driver should
  //    fire the splash celebration.
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1 AND kfi_id = $2`, [
    WEEK_START,
    DRIVERS[0].kfiId,
  ]);
  await page.reload();
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();
  await expect(splash).toHaveCount(0);
  // Mark driver 1 reviewed first (was cleared by the DELETE above).
  await bubble1.click();
  await expect(pill).toHaveText("2 / 3 reviewed");
  await expect(splash).toHaveCount(0);
  // Now flip the final unreviewed driver — splash appears.
  await bubble3.click();
  await expect(pill).toHaveText("All reviewed");
  await expect(splash).toBeVisible();

  // 5. Dismiss the splash, then reload the page. The week is still fully
  //    reviewed but the splash must NOT re-appear (no re-trigger on
  //    static all-reviewed state, only on the transition).
  await page.getByTestId("button-all-reviewed-dismiss").click();
  await expect(splash).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();
  await expect(pill).toHaveText("All reviewed");
  // Give the celebration hook a chance to (incorrectly) fire if it were
  // going to — it shouldn't, because the very first observation of this
  // week is "already all reviewed".
  await page.waitForTimeout(500);
  await expect(splash).toHaveCount(0);
});

test("dashboard-only: toggling the last unreviewed driver from the week summary fires the splash, even after driver-detail recorded its own baseline first", async ({
  page,
}) => {
  // Reset reviewed state for this week so we start from zero-reviewed.
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);

  const splash = page.getByTestId("all-reviewed-splash");
  const summaryPill = page.getByTestId("pill-week-reviewed-progress");

  // 1. Visit driver-detail first. This is the regression scenario from
  //    task #164: the celebration hook used to be keyed by weekStart only,
  //    so whichever surface observed the week first recorded the baseline
  //    and the other surface would silently skip the celebration.
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`);
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();
  await expect(splash).toHaveCount(0);

  // 2. Navigate to the week dashboard (same SPA, no reload) and mark every
  //    driver reviewed from there. The last toggle should trigger the
  //    splash on the dashboard surface.
  await page.goto(`/weeks/${WEEK_START}`);
  await expect(summaryPill).toBeVisible();
  await expect(summaryPill).toHaveText("0 / 3 reviewed");
  await expect(splash).toHaveCount(0);

  await page
    .getByTestId(`checkbox-reviewed-${DRIVERS[0].kfiId}`)
    .click();
  await expect(summaryPill).toHaveText("1 / 3 reviewed");
  await expect(splash).toHaveCount(0);

  await page
    .getByTestId(`checkbox-reviewed-${DRIVERS[1].kfiId}`)
    .click();
  await expect(summaryPill).toHaveText("2 / 3 reviewed");
  await expect(splash).toHaveCount(0);

  // Final toggle — splash must appear on the dashboard.
  await page
    .getByTestId(`checkbox-reviewed-${DRIVERS[2].kfiId}`)
    .click();
  await expect(summaryPill).toHaveText("All reviewed");
  await expect(splash).toBeVisible();

  await page.getByTestId("button-all-reviewed-dismiss").click();
  await expect(splash).toHaveCount(0);
});
