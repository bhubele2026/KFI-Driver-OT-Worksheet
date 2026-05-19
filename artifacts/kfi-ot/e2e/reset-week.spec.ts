/**
 * End-to-end coverage for the admin "Reset Week" flow
 * (artifacts/kfi-ot/src/pages/week-summary.tsx +
 * POST /api/weeks/:weekStart/reset).
 *
 * Verifies:
 *   - As an admin, opening the Reset Week dialog, choosing the
 *     `punches-and-reviewed` scope, and typing the week start to confirm
 *     hard-deletes every punch and clears the reviewed flag, while
 *     stamping a `punch_deletions` row per removed punch and a
 *     `week-reset` row in `user_audit_log`.
 *   - As a non-admin (auth/me stubbed), the Reset Week button is not
 *     rendered and a direct POST to the reset route returns 403.
 *   - When any driver-week is locked, the reset route returns 409 with
 *     a `lockedKfiIds` payload and does NOT touch any punches.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the reset-week e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-04-27";
const WEEK_END = "2031-05-03";
const SUFFIX = `e2e-rw-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-RW-${SUFFIX}`,
  name: "Reset Week Tester",
  customer: "Adient",
};

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
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
      [DRIVER.kfiId, DRIVER.name, DRIVER.customer],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function seedPunches(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const hour = 6 + i;
    await pool.query(
      `INSERT INTO punches (
         week_start, kfi_id, customer, source, is_manual,
         date, clock_in, clock_out, hours, created_by, updated_by
       ) VALUES ($1, $2, $3, 'Driver', false, $4, $5, $6, $7, NULL, NULL)`,
      [
        WEEK_START,
        DRIVER.kfiId,
        DRIVER.customer,
        "2031-04-28",
        `2031-04-28 ${hour}:00 AM`,
        `2031-04-28 ${hour + 1}:00 AM`,
        1,
      ],
    );
  }
}

async function clearDataOnly(): Promise<void> {
  // Wipe only the week-scoped rows that the test creates. Preserves the
  // driver + week scaffolding so multiple test runs reuse them safely.
  await pool.query(`DELETE FROM punch_deletions WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(
    `DELETE FROM reviewed_drivers WHERE week_start = $1`,
    [WEEK_START],
  );
  await pool.query(
    `DELETE FROM user_audit_log WHERE action = 'week-reset' AND target_email LIKE $1`,
    [`week-reset:${WEEK_START}|%`],
  );
}

async function cleanup(): Promise<void> {
  await clearDataOnly();
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [DRIVER.kfiId]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test.beforeEach(async () => {
  await clearDataOnly();
});

test("admin can reset a week (punches + reviewed) via the dialog", async ({
  page,
}) => {
  // Seed: 3 driver punches and a reviewed flag.
  await seedPunches(3);
  await pool.query(
    `INSERT INTO reviewed_drivers (week_start, kfi_id, reviewed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (week_start, kfi_id) DO UPDATE SET reviewed_at = EXCLUDED.reviewed_at`,
    [WEEK_START, DRIVER.kfiId],
  );

  // Sign in via the dev auth bypass and land on the target week.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto(`/weeks/${WEEK_START}`);

  await expect(
    page.getByRole("heading", { name: `Week of ${WEEK_START}` }),
  ).toBeVisible();

  // 1. Open the Reset Week dialog.
  await page.getByTestId("button-open-reset-week").click();
  await expect(page.getByTestId("dialog-reset-week")).toBeVisible();

  // 2. Choose the punches-and-reviewed scope.
  await page
    .getByTestId("radio-reset-scope-punches-and-reviewed")
    .click();

  // 3. Confirm button is disabled until the date is typed verbatim.
  const confirmBtn = page.getByTestId("button-reset-confirm");
  await expect(confirmBtn).toBeDisabled();
  await page.getByTestId("input-reset-confirm").fill("wrong");
  await expect(confirmBtn).toBeDisabled();
  await page.getByTestId("input-reset-confirm").fill(WEEK_START);
  await expect(confirmBtn).toBeEnabled();

  // 4. Submit and wait for the API call to settle.
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/weeks/${WEEK_START}/reset`) &&
        r.request().method() === "POST",
    ),
    confirmBtn.click(),
  ]);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.punchesDeleted).toBe(3);
  expect(body.reviewedDeleted).toBe(1);
  expect(body.scope).toBe("punches-and-reviewed");

  // Dialog closes on success.
  await expect(page.getByTestId("dialog-reset-week")).toHaveCount(0);

  // 5. DB: every punch is gone, but one punch_deletions row per removed
  // punch exists with the right week + driver.
  const punchCount = await pool
    .query<{ count: string }>(
      `SELECT count(*)::text AS count FROM punches WHERE week_start = $1`,
      [WEEK_START],
    )
    .then((r) => Number(r.rows[0].count));
  expect(punchCount).toBe(0);

  const deletionCount = await pool
    .query<{ count: string }>(
      `SELECT count(*)::text AS count FROM punch_deletions
        WHERE week_start = $1 AND kfi_id = $2`,
      [WEEK_START, DRIVER.kfiId],
    )
    .then((r) => Number(r.rows[0].count));
  expect(deletionCount).toBe(3);

  // 6. DB: reviewed_drivers is empty for this week.
  const reviewedCount = await pool
    .query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reviewed_drivers WHERE week_start = $1`,
      [WEEK_START],
    )
    .then((r) => Number(r.rows[0].count));
  expect(reviewedCount).toBe(0);

  // 7. user_audit_log carries one append-only week-reset row with the
  //    expected synthetic targetEmail.
  const auditRow = await pool
    .query<{ target_email: string }>(
      `SELECT target_email FROM user_audit_log
        WHERE action = 'week-reset' AND target_email LIKE $1
        ORDER BY id DESC LIMIT 1`,
      [`week-reset:${WEEK_START}|%`],
    )
    .then((r) => r.rows[0]);
  expect(auditRow).toBeTruthy();
  expect(auditRow.target_email).toBe(
    `week-reset:${WEEK_START}|scope=punches-and-reviewed|punches=3|reviewed=1|notes=0`,
  );
});

test("non-admin cannot see the Reset Week button and cannot call the route", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Stub me + dev-bypass to return a non-admin so the AuthGate never
  // promotes the dev user.
  const stubUser = {
    id: 999_999,
    email: "non-admin-e2e@kfi.local",
    isAdmin: false,
    isActive: true,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stubUser),
    });
  });
  await page.route("**/api/auth/dev-bypass", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stubUser),
    });
  });

  await page.goto(`/weeks/${WEEK_START}`);
  await expect(
    page.getByRole("heading", { name: `Week of ${WEEK_START}` }),
  ).toBeVisible();

  // The button is admin-only and must not render for the non-admin.
  await expect(page.getByTestId("button-open-reset-week")).toHaveCount(0);

  // A direct POST is also rejected server-side: the API never sees an
  // admin session for this stubbed user, so the route either 401s
  // (no session at all — page.request has its own cookie jar separate
  // from the page) or 403s (session exists but not an admin). Either
  // way, the non-admin cannot reset.
  const resp = await page.request.post(
    `/api/weeks/${WEEK_START}/reset`,
    {
      data: { scope: "punches-only", confirm: WEEK_START },
      failOnStatusCode: false,
    },
  );
  expect([401, 403]).toContain(resp.status());

  await context.close();
});

test("reset returns 409 when any driver-week is locked", async ({ page }) => {
  // Seed: 1 punch + a locked reviewed_drivers row.
  await seedPunches(1);
  await pool.query(
    `INSERT INTO reviewed_drivers (week_start, kfi_id, reviewed_at, locked_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (week_start, kfi_id) DO UPDATE
       SET reviewed_at = EXCLUDED.reviewed_at, locked_at = EXCLUDED.locked_at`,
    [WEEK_START, DRIVER.kfiId],
  );

  // Sign in via the dev auth bypass.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const resp = await page.request.post(
    `/api/weeks/${WEEK_START}/reset`,
    {
      data: { scope: "punches-only", confirm: WEEK_START },
      failOnStatusCode: false,
    },
  );
  expect(resp.status()).toBe(409);
  const body = await resp.json();
  expect(Array.isArray(body.lockedKfiIds)).toBe(true);
  expect(body.lockedKfiIds).toContain(DRIVER.kfiId);

  // Critically: no punches were touched.
  const punchCount = await pool
    .query<{ count: string }>(
      `SELECT count(*)::text AS count FROM punches WHERE week_start = $1`,
      [WEEK_START],
    )
    .then((r) => Number(r.rows[0].count));
  expect(punchCount).toBe(1);

  // And no audit row was written.
  const auditCount = await pool
    .query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_audit_log
        WHERE action = 'week-reset' AND target_email LIKE $1`,
      [`week-reset:${WEEK_START}|%`],
    )
    .then((r) => Number(r.rows[0].count));
  expect(auditCount).toBe(0);

  // Clean up the lock so afterAll can DELETE reviewed_drivers.
  await pool.query(
    `UPDATE reviewed_drivers SET locked_at = NULL WHERE week_start = $1`,
    [WEEK_START],
  );
});
