/**
 * End-to-end coverage for the dispatcher keyboard shortcuts on the
 * driver-detail page (artifacts/kfi-ot/src/pages/driver-detail.tsx).
 *
 * Verifies:
 *   - j / k cycle through every driver in sidebar order, with wrap-around.
 *   - n / p skip already-reviewed drivers and reach the next / previous
 *     unreviewed one, including wrap-around in both directions.
 *   - When all drivers are reviewed, n and p both show the "All drivers
 *     reviewed for this week" toast and do not navigate.
 *   - r toggles the current driver's reviewed state.
 *   - ? opens and closes the keyboard-shortcuts help dialog.
 *   - Shortcuts are suppressed while the Add Punch dialog is open.
 *   - Shortcuts are suppressed while focus is in an input (including ?).
 *
 * Seeds an isolated week via direct DB writes so the test does not depend
 * on existing data, and cleans up afterwards.
 */
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the keyboard-shortcuts e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Pick a Sunday far enough in the future that it does not collide with
// real dispatcher data already in the dev database.
const WEEK_START = "2031-03-02";
const WEEK_END = "2031-03-08";

const SUFFIX = `e2e-${Date.now().toString(36)}`;
// Sidebar order is: customers in KNOWN_CUSTOMERS order (Adient before
// Burnett), then drivers within a customer sorted alphabetically by name.
// So this seed yields the visual order [d1, d2, d3, d4].
const DRIVERS = [
  { kfiId: `KFI-J1-${SUFFIX}`, name: "AAA Driver One", customer: "Adient" },
  { kfiId: `KFI-J2-${SUFFIX}`, name: "BBB Driver Two", customer: "Adient" },
  { kfiId: `KFI-J3-${SUFFIX}`, name: "AAA Driver Three", customer: "Burnett" },
  { kfiId: `KFI-J4-${SUFFIX}`, name: "BBB Driver Four", customer: "Burnett" },
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
    // Drivers 2 and 4 begin as reviewed; 1 and 3 unreviewed.
    for (const kfiId of [DRIVERS[1].kfiId, DRIVERS[3].kfiId]) {
      await client.query(
        `INSERT INTO reviewed_drivers (week_start, kfi_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [WEEK_START, kfiId],
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

async function markAllReviewed(): Promise<void> {
  for (const d of DRIVERS) {
    await pool.query(
      `INSERT INTO reviewed_drivers (week_start, kfi_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [WEEK_START, d.kfiId],
    );
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

function driverPath(kfiId: string): string {
  return `/weeks/${WEEK_START}/drivers/${kfiId}`;
}

async function gotoDriver(page: Page, kfiId: string): Promise<void> {
  await page.goto(driverPath(kfiId));
  // Sidebar render confirms the week summary loaded too.
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();
  await expect(
    page.getByTestId(`sidebar-driver-${DRIVERS[0].kfiId}`),
  ).toBeVisible();
}

async function expectDriver(page: Page, kfiId: string): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).pathname, {
      timeout: 5_000,
      message: `expected URL pathname to end with /drivers/${kfiId}`,
    })
    .toBe(driverPath(kfiId));
}

async function ensureBodyFocus(page: Page): Promise<void> {
  // Click the page heading so focus is not in any input/dialog.
  await page.locator("h1").first().click();
}

test.beforeAll(async () => {
  await cleanup(); // defensive — ignore prior partial runs
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("dispatcher keyboard shortcuts on the driver-detail page", async ({
  page,
}) => {
  // 0. Disable the "auto-advance after marking reviewed" preference so the
  //    `r` shortcut does not also navigate away mid-test.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("kfi-ot:auto-advance-reviewed:v1", "0");
    } catch {
      /* ignore */
    }
  });

  // 1. Trigger dev auth bypass by hitting the root, then land on the first
  //    driver. The AuthGate POSTs /api/auth/dev-bypass on first load in dev.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await gotoDriver(page, DRIVERS[0].kfiId);
  await expect(page.getByRole("heading", { name: DRIVERS[0].name })).toBeVisible();

  // 2. j / k cycle in sidebar order, with wrap-around.
  await ensureBodyFocus(page);
  await page.keyboard.press("j");
  await expectDriver(page, DRIVERS[1].kfiId);
  await page.keyboard.press("j");
  await expectDriver(page, DRIVERS[2].kfiId);
  await page.keyboard.press("j");
  await expectDriver(page, DRIVERS[3].kfiId);
  await page.keyboard.press("j");
  await expectDriver(page, DRIVERS[0].kfiId); // wrap forward

  await page.keyboard.press("k");
  await expectDriver(page, DRIVERS[3].kfiId); // wrap backward
  await page.keyboard.press("k");
  await expectDriver(page, DRIVERS[2].kfiId);

  // 3. n skips already-reviewed drivers (2 and 4 are reviewed).
  await gotoDriver(page, DRIVERS[0].kfiId);
  await expect(page.getByRole("heading", { name: DRIVERS[0].name })).toBeVisible();
  await ensureBodyFocus(page);

  await page.keyboard.press("n");
  // From driver 1 forward: driver 2 reviewed → skip → land on driver 3.
  await expectDriver(page, DRIVERS[2].kfiId);

  await page.keyboard.press("n");
  // From driver 3 forward: driver 4 reviewed → skip → wrap → driver 1
  // (driver 2 still reviewed but driver 1 is reached first).
  await expectDriver(page, DRIVERS[0].kfiId);

  // 3b. p walks backwards skipping reviewed drivers, with wrap-around.
  await gotoDriver(page, DRIVERS[0].kfiId);
  await ensureBodyFocus(page);
  await page.keyboard.press("p");
  // From driver 1 backward: wrap → driver 4 reviewed → skip → driver 3.
  await expectDriver(page, DRIVERS[2].kfiId);
  await page.keyboard.press("p");
  // From driver 3 backward: driver 2 reviewed → skip → driver 1.
  await expectDriver(page, DRIVERS[0].kfiId);

  // 3c. r toggles the current driver's reviewed state. Auto-advance is
  //     disabled (see step 0) so the URL must not change.
  await gotoDriver(page, DRIVERS[0].kfiId);
  await ensureBodyFocus(page);
  const reviewedCheckbox = page.locator("#reviewed");
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "unchecked");
  const beforeRUrl = new URL(page.url()).pathname;
  await page.keyboard.press("r");
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "checked");
  expect(new URL(page.url()).pathname).toBe(beforeRUrl);
  // Toggle back so step 4 starts from a known state.
  await page.keyboard.press("r");
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "unchecked");
  expect(new URL(page.url()).pathname).toBe(beforeRUrl);

  // 4. When every driver is reviewed, n shows the toast and does not navigate.
  await markAllReviewed();
  await page.reload();
  await expect(page.getByRole("heading", { name: DRIVERS[0].name })).toBeVisible();
  await ensureBodyFocus(page);

  const beforeAllReviewedUrl = new URL(page.url()).pathname;
  await page.keyboard.press("n");
  await expect(
    page.getByText("All drivers reviewed for this week").first(),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(beforeAllReviewedUrl);

  // 4b. p behaves the same way: toast and no navigation.
  await page.keyboard.press("p");
  await expect(
    page.getByText("All drivers reviewed for this week").first(),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(beforeAllReviewedUrl);

  // 4c. ? toggles the keyboard-shortcuts help dialog open and closed.
  await ensureBodyFocus(page);
  const shortcutsDialog = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
  });
  await expect(shortcutsDialog).toHaveCount(0);
  await page.keyboard.press("Shift+Slash");
  await expect(shortcutsDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shortcutsDialog).toHaveCount(0);

  // 5. Shortcuts suppressed while focus is in an input — including ? and r.
  const search = page.getByTestId("input-sidebar-search");
  await search.click();
  await search.focus();
  await page.keyboard.press("j");
  await page.keyboard.press("n");
  await page.keyboard.press("p");
  await page.keyboard.press("r");
  await page.keyboard.press("Shift+Slash");
  // No navigation occurred; URL still on driver 1.
  expect(new URL(page.url()).pathname).toBe(driverPath(DRIVERS[0].kfiId));
  // Shortcuts dialog did not open from the input.
  await expect(shortcutsDialog).toHaveCount(0);
  // Keystrokes landed in the input.
  await expect(search).toHaveValue(/jnpr\?/i);
  await search.fill("");

  // 6. Shortcuts suppressed while the Add Punch dialog is open.
  await ensureBodyFocus(page);
  await page.getByRole("button", { name: "Add Punch" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const beforeDialogUrl = new URL(page.url()).pathname;
  await page.keyboard.press("j");
  // Dialog stays open and URL did not change.
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(beforeDialogUrl);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
