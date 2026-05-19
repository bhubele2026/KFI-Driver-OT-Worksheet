/**
 * End-to-end coverage for the per-customer / per-driver timezone admin page.
 *
 * Surfaces touched:
 *   - `/admin/timezones` page (`artifacts/kfi-ot/src/pages/admin-timezones.tsx`)
 *   - `customer_tz_preferences` CRUD routes in
 *     `artifacts/api-server/src/routes/weeks.ts` (GET / PUT / DELETE under
 *     `/api/customer-tz-preferences`).
 *
 * The test is intentionally narrow — it exercises the admin-only CRUD round
 * trip (create → re-render → change → delete) so a regression in either the
 * route layer or the admin UI is caught at merge time. Per-driver overrides
 * are covered indirectly by the dispatchTz unit test
 * (`artifacts/api-server/src/lib/__tests__/dispatchTz.test.ts`) which pins
 * the resolution precedence.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the timezones e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-tz-${Date.now().toString(36)}`;
const CUSTOMER = `ZZZ-TZ-${SUFFIX}`;

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM customer_tz_preferences WHERE customer = $1`,
    [CUSTOMER],
  );
}

test.beforeAll(cleanup);
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("admin can create, change, and delete a customer tz preference", async ({
  page,
}) => {
  // AuthGate dev bypass: hit "/" first so we land in as an admin.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto("/admin/timezones");
  await expect(
    page.getByRole("heading", { name: "Timezones" }),
  ).toBeVisible();

  // 1. Create a new preference (Chicago default → set to Denver).
  await page.getByPlaceholder("Adient, IWG, Penda…").fill(CUSTOMER);
  // Open the "new preference" tz select (the first one on the page).
  const tzSelects = page.getByRole("combobox");
  await tzSelects.first().click();
  await page
    .getByRole("option", { name: "America/Denver" })
    .click();
  await page.getByRole("button", { name: /^Save$/ }).click();

  // The newly-saved row appears in the per-customer table with the
  // selected tz.
  const row = page.locator("tr", { hasText: CUSTOMER });
  await expect(row).toBeVisible();
  await expect(row.getByText("America/Denver")).toBeVisible();

  // Confirm the DB has it.
  const created = await pool.query<{ display_tz: string }>(
    `SELECT display_tz FROM customer_tz_preferences WHERE customer = $1`,
    [CUSTOMER],
  );
  expect(created.rowCount).toBe(1);
  expect(created.rows[0]!.display_tz).toBe("America/Denver");

  // 2. Change it via the per-row select to Phoenix.
  await row.getByRole("combobox").click();
  await page
    .getByRole("option", { name: "America/Phoenix" })
    .click();
  await expect(row.getByText("America/Phoenix")).toBeVisible();

  const updated = await pool.query<{ display_tz: string }>(
    `SELECT display_tz FROM customer_tz_preferences WHERE customer = $1`,
    [CUSTOMER],
  );
  expect(updated.rows[0]!.display_tz).toBe("America/Phoenix");

  // 3. Delete the preference — the row disappears.
  await row.getByRole("button", { name: /Clear preference/i }).click();
  await expect(page.locator("tr", { hasText: CUSTOMER })).toHaveCount(0);

  const deleted = await pool.query(
    `SELECT 1 FROM customer_tz_preferences WHERE customer = $1`,
    [CUSTOMER],
  );
  expect(deleted.rowCount).toBe(0);
});
