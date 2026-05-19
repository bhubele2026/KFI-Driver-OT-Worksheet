/**
 * End-to-end coverage for the admin AI samples page
 * (artifacts/kfi-ot/src/pages/admin-ai-samples.tsx).
 *
 * Verifies:
 *   - As an admin, the page renders stashed samples grouped by customer,
 *     the customer filter narrows the table, and the Download link points
 *     at /api/admin/ai-extract-samples/:id/download.
 *   - As a non-admin (auth/me stubbed), the page redirects to "/".
 *
 * Seeds two ai_extract_samples rows under unique e2e-only customer names
 * via direct DB writes so the test does not depend on existing data, and
 * cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the admin-ai-samples e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const CUSTOMER_A = `ZZZ-E2E-Alpha-${SUFFIX}`;
const CUSTOMER_B = `ZZZ-E2E-Beta-${SUFFIX}`;
const WEEK_START = "2031-04-06";

const SAMPLES = [
  {
    customer: CUSTOMER_A,
    fileName: `alpha-${SUFFIX}.xlsx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: Buffer.from("alpha-fixture"),
  },
  {
    customer: CUSTOMER_A,
    fileName: `alpha-2-${SUFFIX}.xlsx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: Buffer.from("alpha-fixture-2"),
  },
  {
    customer: CUSTOMER_B,
    fileName: `beta-${SUFFIX}.pdf`,
    mimeType: "application/pdf",
    bytes: Buffer.from("%PDF-1.4 beta-fixture"),
  },
] as const;

const insertedIds: number[] = [];

async function seed(): Promise<void> {
  for (const s of SAMPLES) {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO ai_extract_samples
         (week_start, customer, file_name, mime_type, size_bytes,
          file_bytes, uploaded_by, uploaded_at, confirmed_at, expires_at,
          pinned)
       VALUES ($1::date, $2, $3, $4, $5, $6, NULL, now(), now(),
               now() + interval '30 days', false)
       RETURNING id`,
      [WEEK_START, s.customer, s.fileName, s.mimeType, s.bytes.length, s.bytes],
    );
    insertedIds.push(r.rows[0].id);
  }
}

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM ai_extract_samples WHERE customer = ANY($1::text[])`,
    [[CUSTOMER_A, CUSTOMER_B]],
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

test("admin can view, filter, and download stashed AI samples", async ({
  page,
}) => {
  // Trigger the dev auth bypass first so /admin/ai-samples sees an admin.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.goto("/admin/ai-samples");
  await expect(
    page.getByRole("heading", { name: "Admin · AI samples" }),
  ).toBeVisible();

  // Both seeded customer groups render as h3s with the expected sample counts.
  const alphaHeading = page.getByRole("heading", { name: CUSTOMER_A });
  const betaHeading = page.getByRole("heading", { name: CUSTOMER_B });
  await expect(alphaHeading).toBeVisible();
  await expect(betaHeading).toBeVisible();

  // Each seeded file name appears in a row.
  for (const s of SAMPLES) {
    await expect(page.getByText(s.fileName, { exact: true })).toBeVisible();
  }

  // The Alpha download link points at the admin download endpoint with the
  // correct sample id. Sample order in the listing is desc by uploaded_at,
  // so the most-recently-inserted Alpha row (insertedIds[1]) appears first
  // under the Alpha group, but we only assert the URL shape — the id can be
  // either of the two Alpha ids we inserted.
  const alphaIds = new Set([insertedIds[0], insertedIds[1]]);
  const firstAlphaLink = page
    .locator(`a[href$="/api/admin/ai-extract-samples/${insertedIds[0]}/download"], a[href$="/api/admin/ai-extract-samples/${insertedIds[1]}/download"]`)
    .first();
  await expect(firstAlphaLink).toBeVisible();
  const href = await firstAlphaLink.getAttribute("href");
  expect(href).toBeTruthy();
  const match = href!.match(/\/api\/admin\/ai-extract-samples\/(\d+)\/download$/);
  expect(match).not.toBeNull();
  expect(alphaIds.has(Number(match![1]))).toBe(true);

  // The Beta download link points at the Beta sample id.
  const betaLink = page.locator(
    `a[href$="/api/admin/ai-extract-samples/${insertedIds[2]}/download"]`,
  );
  await expect(betaLink).toBeVisible();

  // Filter to Alpha — Beta group should disappear.
  await page.getByRole("combobox").click();
  await page
    .getByRole("option", { name: CUSTOMER_A, exact: true })
    .click();
  await expect.poll(() => page.url()).toContain(
    `customer=${encodeURIComponent(CUSTOMER_A)}`,
  );
  await expect(alphaHeading).toBeVisible();
  await expect(betaHeading).toHaveCount(0);

  // Clear the filter — both groups return.
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(alphaHeading).toBeVisible();
  await expect(betaHeading).toBeVisible();
});

test("admin can pin and unpin a stashed AI sample", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.goto("/admin/ai-samples");
  await expect(
    page.getByRole("heading", { name: "Admin · AI samples" }),
  ).toBeVisible();

  // Operate on the Beta sample (only one row under that customer group).
  const betaId = insertedIds[2];
  const betaRow = page.locator(
    `tr:has(a[href$="/api/admin/ai-extract-samples/${betaId}/download"])`,
  );
  await expect(betaRow).toBeVisible();

  // Initially: no Pinned badge, no amber tint.
  await expect(betaRow.getByText("Pinned", { exact: true })).toHaveCount(0);
  await expect(betaRow).not.toHaveClass(/bg-amber-50/);

  // Click Pin → badge + amber tint appear, button flips to "Unpin".
  await betaRow.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(betaRow.getByText("Pinned", { exact: true })).toBeVisible();
  await expect(betaRow).toHaveClass(/bg-amber-50/);
  await expect(
    betaRow.getByRole("button", { name: "Unpin", exact: true }),
  ).toBeVisible();

  // DB reflects the pin.
  const afterPin = await pool.query<{ pinned: boolean }>(
    `SELECT pinned FROM ai_extract_samples WHERE id = $1`,
    [betaId],
  );
  expect(afterPin.rows[0].pinned).toBe(true);

  // Click Unpin → badge + tint disappear, button flips back to "Pin".
  await betaRow.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(betaRow.getByText("Pinned", { exact: true })).toHaveCount(0);
  await expect(betaRow).not.toHaveClass(/bg-amber-50/);
  await expect(
    betaRow.getByRole("button", { name: "Pin", exact: true }),
  ).toBeVisible();

  const afterUnpin = await pool.query<{ pinned: boolean }>(
    `SELECT pinned FROM ai_extract_samples WHERE id = $1`,
    [betaId],
  );
  expect(afterUnpin.rows[0].pinned).toBe(false);
});

test("pinned sample with expired expires_at still appears in the listing", async ({
  page,
}) => {
  // Pin the Alpha[0] row and backdate its expires_at directly in the DB.
  const pinnedExpiredId = insertedIds[0];
  await pool.query(
    `UPDATE ai_extract_samples
        SET pinned = true,
            expires_at = now() - interval '7 days'
      WHERE id = $1`,
    [pinnedExpiredId],
  );

  // Trigger the dev auth bypass so the page.request below carries an admin
  // session cookie, then hit the listing endpoint directly.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const res = await page.request.get("/api/admin/ai-extract-samples");
  expect(res.status()).toBe(200);
  const rows: Array<{ id: number; pinned: boolean }> = await res.json();
  const found = rows.find((r) => r.id === pinnedExpiredId);
  expect(found, "pinned-but-expired sample should survive the predicate").toBeTruthy();
  expect(found!.pinned).toBe(true);

  // Sanity check: an unpinned + expired row would *not* appear. Backdate the
  // Beta sample's expires_at without pinning it and confirm it's filtered out.
  const expiredOnlyId = insertedIds[2];
  await pool.query(
    `UPDATE ai_extract_samples
        SET pinned = false,
            expires_at = now() - interval '7 days'
      WHERE id = $1`,
    [expiredOnlyId],
  );
  const res2 = await page.request.get("/api/admin/ai-extract-samples");
  expect(res2.status()).toBe(200);
  const rows2: Array<{ id: number }> = await res2.json();
  expect(rows2.find((r) => r.id === expiredOnlyId)).toBeUndefined();
  // The pinned-expired row is still present.
  expect(rows2.find((r) => r.id === pinnedExpiredId)).toBeTruthy();
});

test("non-admin is redirected away from /admin/ai-samples", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Stub /api/auth/me to return a non-admin user before the AuthGate calls
  // it. We also stub the dev-bypass POST to a no-op so it cannot promote
  // the dev user back to admin in the DB.
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 999_999,
        email: "non-admin-e2e@kfi.local",
        isAdmin: false,
        isActive: true,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      }),
    });
  });
  await page.route("**/api/auth/dev-bypass", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 999_999,
        email: "non-admin-e2e@kfi.local",
        isAdmin: false,
        isActive: true,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      }),
    });
  });

  await page.goto("/admin/ai-samples");

  // The Redirect to "/" should land us on the week-summary route. The page
  // never renders the "Admin · AI samples" heading.
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 5_000 })
    .toBe("/");
  await expect(
    page.getByRole("heading", { name: "Admin · AI samples" }),
  ).toHaveCount(0);

  await context.close();
});
