/**
 * End-to-end coverage for marking drivers reviewed from two entry points:
 *   1. Sidebar double-click on a driver row (DriversList in
 *      artifacts/kfi-ot/src/components/drivers-sidebar.tsx).
 *   2. The header "Reviewed" checkbox on the per-driver page
 *      (artifacts/kfi-ot/src/pages/driver-detail.tsx).
 *
 * Verifies that both paths flip the driver's reviewed state and that the
 * sidebar icon and the header progress pill ("X / N reviewed") update.
 *
 * Auto-advance is disabled via localStorage so that toggling the currently
 * selected driver does not navigate away mid-test.
 *
 * Seeds an isolated week via direct DB writes and cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the reviewed-toggle e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-04-06";
const WEEK_END = "2031-04-12";
const SUFFIX = `e2e-rt-${Date.now().toString(36)}`;
// Sidebar order is customer (KNOWN_CUSTOMERS), then alphabetical by name.
const DRIVERS = [
  { kfiId: `KFI-R1-${SUFFIX}`, name: "AAA Reviewed One", customer: "Adient" },
  { kfiId: `KFI-R2-${SUFFIX}`, name: "BBB Reviewed Two", customer: "Adient" },
  { kfiId: `KFI-R3-${SUFFIX}`, name: "CCC Reviewed Three", customer: "Adient" },
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

test("toggling reviewed from header checkbox and sidebar double-click both update sidebar + summary pill", async ({
  page,
}) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("kfi-ot:auto-advance-reviewed:v1", "0");
    } catch {
      /* ignore */
    }
  });

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`);
  await expect(
    page.getByRole("heading", { name: DRIVERS[0].name }),
  ).toBeVisible();
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();

  const pill = page.getByTestId("pill-reviewed-progress");
  const reviewedCheckbox = page.locator("#reviewed");
  const sidebarRow1 = page.getByTestId(`sidebar-driver-${DRIVERS[0].kfiId}`);
  const sidebarRow2 = page.getByTestId(`sidebar-driver-${DRIVERS[1].kfiId}`);

  // Baseline: nothing reviewed yet.
  await expect(pill).toHaveText("0 / 3 reviewed");
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "unchecked");
  // Sidebar uses CheckCircle2 (text-emerald-*) when reviewed; Circle otherwise.
  await expect(
    sidebarRow1.locator("svg.text-emerald-600, svg.text-emerald-400"),
  ).toHaveCount(0);

  // 1. Header checkbox path: click to mark current driver reviewed.
  await reviewedCheckbox.click();
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "checked");
  await expect(pill).toHaveText("1 / 3 reviewed");
  // Sidebar row for the selected driver flips to the reviewed icon.
  await expect(
    sidebarRow1.locator("svg.text-emerald-600, svg.text-emerald-400"),
  ).toHaveCount(1);
  // URL must not change — auto-advance is disabled.
  expect(new URL(page.url()).pathname).toBe(
    `/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`,
  );

  // 2. Sidebar double-click path: navigate to driver 2, then dblclick its
  //    own sidebar row. We dblclick the *currently-selected* row so the
  //    intervening single click is a no-op navigation (same URL) and the
  //    DriverDetail loaded/loading-state remount does not race the
  //    dblclick away. With auto-advance disabled, the URL stays at
  //    driver 2 and the pill bumps to 2 / 3 reviewed.
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVERS[1].kfiId}`);
  await expect(
    page.getByRole("heading", { name: DRIVERS[1].name }),
  ).toBeVisible();
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "unchecked");
  await expect(pill).toHaveText("1 / 3 reviewed");

  await sidebarRow2.dblclick();
  await expect(pill).toHaveText("2 / 3 reviewed");
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "checked");
  await expect(
    sidebarRow2.locator("svg.text-emerald-600, svg.text-emerald-400"),
  ).toHaveCount(1);
  expect(new URL(page.url()).pathname).toBe(
    `/weeks/${WEEK_START}/drivers/${DRIVERS[1].kfiId}`,
  );

  // 3. Untoggle via sidebar double-click on the currently-selected
  //    (now reviewed) row.
  await sidebarRow2.dblclick();
  await expect(pill).toHaveText("1 / 3 reviewed");
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "unchecked");
  await expect(
    sidebarRow2.locator("svg.text-emerald-600, svg.text-emerald-400"),
  ).toHaveCount(0);

  // 4. Untoggle via the header checkbox path: navigate back to driver 1
  //    and click the checkbox to flip it off.
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`);
  await expect(
    page.getByRole("heading", { name: DRIVERS[0].name }),
  ).toBeVisible();
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "checked");
  await reviewedCheckbox.click();
  await expect(reviewedCheckbox).toHaveAttribute("data-state", "unchecked");
  await expect(pill).toHaveText("0 / 3 reviewed");
  await expect(
    sidebarRow1.locator("svg.text-emerald-600, svg.text-emerald-400"),
  ).toHaveCount(0);
});
