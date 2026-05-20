/**
 * End-to-end coverage for the admin Connecteam user aliases page
 * (artifacts/kfi-ot/src/pages/admin-connecteam-user-aliases.tsx).
 *
 * Verifies:
 *   - As an admin, the page renders DB-backed alias rows and supports
 *     creating + deleting a row through the API.
 *   - As a non-admin (auth/me stubbed), the page redirects to "/".
 *
 * Seeds a unique driver + alias via direct DB writes so the test does not
 * depend on existing data, and cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";


const pool = createE2EPool();

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const DRIVER_A = `zzz-e2e-driver-a-${SUFFIX}`;
const DRIVER_B = `zzz-e2e-driver-b-${SUFFIX}`;
const ALIAS_CT_ID_EXISTING = 900_000_000 + Math.floor(Math.random() * 9_000_000);
const ALIAS_CT_ID_NEW = ALIAS_CT_ID_EXISTING + 1;

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer, is_driver, is_archived)
     VALUES ($1, $2, $3, true, false), ($4, $5, $6, true, false)`,
    [
      DRIVER_A,
      `ZZZ E2E Alpha ${SUFFIX}`,
      "E2E-Customer",
      DRIVER_B,
      `ZZZ E2E Beta ${SUFFIX}`,
      "E2E-Customer",
    ],
  );
  await pool.query(
    `INSERT INTO connecteam_user_aliases (ct_user_id, kfi_id, note)
     VALUES ($1, $2, $3)`,
    [ALIAS_CT_ID_EXISTING, DRIVER_A, `seeded ${SUFFIX}`],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM connecteam_user_aliases WHERE ct_user_id IN ($1, $2)`,
    [ALIAS_CT_ID_EXISTING, ALIAS_CT_ID_NEW],
  );
  await pool.query(`DELETE FROM drivers WHERE kfi_id IN ($1, $2)`, [
    DRIVER_A,
    DRIVER_B,
  ]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("admin can view, create, and delete Connecteam user aliases", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.goto("/admin/connecteam-user-aliases");
  await expect(
    page.getByRole("heading", { name: "Connecteam user aliases" }),
  ).toBeVisible();

  // Seeded row renders with the mapped driver name.
  const seededRow = page.getByTestId(`row-alias-${ALIAS_CT_ID_EXISTING}`);
  await expect(seededRow).toBeVisible();
  await expect(seededRow).toContainText(DRIVER_A);

  // Create a new alias via the API (the form's Radix Select has its own
  // virtual scroll viewport that's awkward to drive in CI when the real
  // driver list is long — the underlying POST is what we want to validate).
  const createRes = await page.request.post(
    "/api/admin/connecteam-user-aliases",
    { data: { ctUserId: ALIAS_CT_ID_NEW, kfiId: DRIVER_B, note: "from e2e" } },
  );
  expect(createRes.status()).toBe(200);

  await page.reload();
  const newRow = page.getByTestId(`row-alias-${ALIAS_CT_ID_NEW}`);
  await expect(newRow).toBeVisible();
  await expect(newRow).toContainText(DRIVER_B);

  const dbAfterCreate = await pool.query<{ kfi_id: string }>(
    `SELECT kfi_id FROM connecteam_user_aliases WHERE ct_user_id = $1`,
    [ALIAS_CT_ID_NEW],
  );
  expect(dbAfterCreate.rows[0]?.kfi_id).toBe(DRIVER_B);

  // Delete the new alias.
  page.once("dialog", (d) => d.accept());
  await page.getByTestId(`button-delete-${ALIAS_CT_ID_NEW}`).click();
  await expect(newRow).toHaveCount(0);

  const dbAfterDelete = await pool.query(
    `SELECT 1 FROM connecteam_user_aliases WHERE ct_user_id = $1`,
    [ALIAS_CT_ID_NEW],
  );
  expect(dbAfterDelete.rowCount).toBe(0);
});

test("non-admin is redirected away from /admin/connecteam-user-aliases", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 999,
        email: "non-admin@example.com",
        isAdmin: false,
        isActive: true,
      }),
    }),
  );

  await page.goto("/admin/connecteam-user-aliases");
  await page.waitForURL("**/");
  await expect(
    page.getByRole("heading", { name: "Connecteam user aliases" }),
  ).toHaveCount(0);
});
