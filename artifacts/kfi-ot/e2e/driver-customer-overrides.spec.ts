/**
 * End-to-end coverage for the per-driver customer override feature
 * (task #235 "Manually move a driver to a different customer").
 *
 * Verifies:
 *   - POST /api/driver-customer-overrides moves a driver to a different
 *     customer on the week summary (and exposes originalCustomer +
 *     overrideSet* fields), and writes a `driver-customer-override`
 *     audit row.
 *   - Override survives a re-fetch of the week summary (the table is
 *     untouched by the Connecteam refresh path; we exercise that by
 *     re-reading /summary after the override is set).
 *   - DELETE /api/driver-customer-overrides?kfiId=... clears the
 *     override and writes a `driver-customer-override-clear` audit row.
 *   - The admin /admin/driver-customer-overrides page lists the active
 *     overrides and supports clearing inline.
 *   - The week dashboard sidebar shows a "moved" badge for the
 *     overridden driver, regrouped under the override customer.
 *
 * Seeds drivers + a single punch via direct DB writes so the test does
 * not depend on existing data, and cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";


const pool = createE2EPool();

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const DRIVER_KFI = `zzz-e2e-dco-${SUFFIX}`;
const DRIVER_NAME = `ZZZ DCO Driver ${SUFFIX}`;
const ORIGINAL_CUSTOMER = `E2E-Original-${SUFFIX}`;
const OVERRIDE_CUSTOMER = `E2E-Override-${SUFFIX}`;
// Sunday of a recent week so weekStart is valid.
const WEEK_START = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
})();

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM driver_customer_overrides WHERE kfi_id = $1`, [
    DRIVER_KFI,
  ]);
  await pool.query(`DELETE FROM punches WHERE kfi_id = $1`, [DRIVER_KFI]);
  await pool.query(
    `DELETE FROM user_audit_log WHERE target_email LIKE $1`,
    [`driver-customer-override:${DRIVER_KFI}%`],
  );
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [DRIVER_KFI]);
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer, is_driver, is_archived)
     VALUES ($1, $2, $3, true, false)`,
    [DRIVER_KFI, DRIVER_NAME, ORIGINAL_CUSTOMER],
  );
  // A single Driver-source punch so the row shows up on the summary
  // (rows with totalHours <= 0 are filtered out).
  await pool.query(
    `INSERT INTO punches
       (kfi_id, customer, week_start, source, is_manual,
        date, clock_in, clock_out, hours, disp_tz, created_at, updated_at)
     VALUES ($1, $2, $3, 'Driver', false,
        $4, $5, $6, 8, 'America/Chicago', NOW(), NOW())`,
    [
      DRIVER_KFI,
      ORIGINAL_CUSTOMER,
      WEEK_START,
      WEEK_START,
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 4:00 PM`,
    ],
  );
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("driver customer override sets, persists across summary refetch, and clears", async ({
  page,
}) => {
  // Sign in / dev bypass.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // 1) Set an override via the API.
  const setRes = await page.request.post(
    "/api/driver-customer-overrides",
    {
      data: {
        kfiId: DRIVER_KFI,
        overrideCustomer: OVERRIDE_CUSTOMER,
      },
    },
  );
  expect(setRes.status()).toBe(200);
  const setBody = (await setRes.json()) as {
    kfiId: string;
    overrideCustomer: string;
    originalCustomer: string | null;
    setByEmail: string | null;
  };
  expect(setBody.kfiId).toBe(DRIVER_KFI);
  expect(setBody.overrideCustomer).toBe(OVERRIDE_CUSTOMER);
  expect(setBody.originalCustomer).toBe(ORIGINAL_CUSTOMER);

  // Audit row written.
  const auditAfterSet = await pool.query<{ action: string }>(
    `SELECT action FROM user_audit_log
      WHERE target_email LIKE $1
      ORDER BY id DESC LIMIT 1`,
    [`driver-customer-override:${DRIVER_KFI}%`],
  );
  expect(auditAfterSet.rows[0]?.action).toBe("driver-customer-override");

  // 2) Week summary reflects the override (and exposes originalCustomer).
  const summaryRes = await page.request.get(
    `/api/weeks/${WEEK_START}/summary`,
  );
  expect(summaryRes.status()).toBe(200);
  const summary = (await summaryRes.json()) as {
    customers: Array<{
      customer: string;
      drivers: Array<{
        kfiId: string;
        customer: string;
        originalCustomer: string | null;
        overrideSetByEmail: string | null;
        overrideSetAt: string | null;
      }>;
    }>;
  };
  const allDrivers = summary.customers.flatMap((g) => g.drivers);
  const ourRow = allDrivers.find((d) => d.kfiId === DRIVER_KFI);
  expect(ourRow).toBeTruthy();
  expect(ourRow!.customer).toBe(OVERRIDE_CUSTOMER);
  expect(ourRow!.originalCustomer).toBe(ORIGINAL_CUSTOMER);
  expect(ourRow!.overrideSetAt).toBeTruthy();
  // Row is grouped under the OVERRIDE customer, not the roster customer.
  const groupedUnder = summary.customers.find((g) =>
    g.drivers.some((d) => d.kfiId === DRIVER_KFI),
  );
  expect(groupedUnder?.customer).toBe(OVERRIDE_CUSTOMER);

  // 3) Roster customer on drivers.customer is untouched (so refresh
  //    can replay against it and the override survives).
  const dbDriver = await pool.query<{ customer: string }>(
    `SELECT customer FROM drivers WHERE kfi_id = $1`,
    [DRIVER_KFI],
  );
  expect(dbDriver.rows[0]?.customer).toBe(ORIGINAL_CUSTOMER);

  // 4) Sidebar shows the "moved" badge on the driver row.
  await page.goto(`/weeks/${WEEK_START}`);
  await expect(
    page.getByTestId(`sidebar-driver-${DRIVER_KFI}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`sidebar-moved-${DRIVER_KFI}`),
  ).toBeVisible();

  // 5) Admin page lists the override row and supports clearing.
  await page.goto("/admin/driver-customer-overrides");
  await expect(
    page.getByRole("heading", { name: "Driver customer overrides" }),
  ).toBeVisible();
  const row = page.getByTestId(`row-override-${DRIVER_KFI}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(OVERRIDE_CUSTOMER);
  await expect(row).toContainText(ORIGINAL_CUSTOMER);

  await page.getByTestId(`clear-override-${DRIVER_KFI}`).click();
  await expect(row).toHaveCount(0);

  // 6) Override is gone from the DB and a clear audit row was written.
  const dbAfterClear = await pool.query(
    `SELECT 1 FROM driver_customer_overrides WHERE kfi_id = $1`,
    [DRIVER_KFI],
  );
  expect(dbAfterClear.rowCount).toBe(0);

  const auditAfterClear = await pool.query<{ action: string }>(
    `SELECT action FROM user_audit_log
      WHERE target_email LIKE $1
      ORDER BY id DESC LIMIT 1`,
    [`driver-customer-override:${DRIVER_KFI}%`],
  );
  expect(auditAfterClear.rows[0]?.action).toBe(
    "driver-customer-override-clear",
  );

  // 7) Summary falls back to the roster customer after clear.
  const summaryAfterClear = await page.request
    .get(`/api/weeks/${WEEK_START}/summary`)
    .then((r) => r.json() as Promise<typeof summary>);
  const clearedRow = summaryAfterClear.customers
    .flatMap((g) => g.drivers)
    .find((d) => d.kfiId === DRIVER_KFI);
  expect(clearedRow?.customer).toBe(ORIGINAL_CUSTOMER);
  expect(clearedRow?.originalCustomer).toBeNull();
});

test("override rejects a no-op match against the roster customer", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const res = await page.request.post("/api/driver-customer-overrides", {
    data: {
      kfiId: DRIVER_KFI,
      overrideCustomer: ORIGINAL_CUSTOMER,
    },
  });
  expect(res.status()).toBe(400);
});

test("override rejects an unknown kfiId", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const res = await page.request.post("/api/driver-customer-overrides", {
    data: {
      kfiId: `does-not-exist-${SUFFIX}`,
      overrideCustomer: OVERRIDE_CUSTOMER,
    },
  });
  expect(res.status()).toBe(404);
});
