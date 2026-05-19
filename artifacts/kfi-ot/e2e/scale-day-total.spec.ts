/**
 * End-to-end coverage for the click-to-edit daily total cell on the
 * per-driver page. Verifies:
 *   - The day-total row appears after the last punch of each date and
 *     shows the engine-derived total.
 *   - Editing the total proportionally scales each punch's `hours` so
 *     they sum exactly to the new value, marks them as `edited`, and the
 *     Total Driver summary row reflects the new total.
 *   - The per-day reset action recomputes hours from clock-in / clock-out
 *     so the daily total returns to the engine-derived value.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the scale-day-total e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-05-12";
const WEEK_END = "2031-05-18";
const PUNCH_DATE = "2031-05-12";
const SUFFIX = `e2e-sdt-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-SDT-${SUFFIX}`,
  name: "Scale Day Tester",
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
    // Two contiguous Driver punches summing to ~8.47h (8:00 AM – 12:14 PM
    // + 12:30 PM – 4:43 PM = 4.233 + 4.217 = 8.45). Use values that don't
    // round-trip to a whole number so the scaling math is non-trivial.
    await client.query(
      `INSERT INTO punches
         (week_start, kfi_id, date, clock_in, clock_out, hours,
          source, customer, is_manual, edited, created_by, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, 'Driver', NULL, true, false, NULL, now()),
         ($1, $2, $3, $7, $8, $9, 'Driver', NULL, true, false, NULL, now())`,
      [
        WEEK_START,
        DRIVER.kfiId,
        PUNCH_DATE,
        `${PUNCH_DATE} 8:00 AM`,
        `${PUNCH_DATE} 12:14 PM`,
        4.23,
        `${PUNCH_DATE} 12:30 PM`,
        `${PUNCH_DATE} 4:43 PM`,
        4.22,
      ],
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
  await pool.query(`DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`, [
    WEEK_START,
    DRIVER.kfiId,
  ]);
  await pool.query(`DELETE FROM punch_deletions WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
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

test("dispatcher can override and reset a daily total; punches scale proportionally", async ({
  page,
}) => {
  // Auto-accept the native window.confirm fired by the reset action.
  page.on("dialog", (d) => {
    void d.accept();
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`);
  await expect(page.getByRole("heading", { name: DRIVER.name })).toBeVisible();

  const totalDriverRow = page.getByTestId("row-summary-total-driver");
  const dayRow = page.getByTestId(`row-day-total-${PUNCH_DATE}`);
  await expect(dayRow).toBeVisible();
  // 4.23 + 4.22 = 8.45 (engine-derived starting total).
  await expect(dayRow).toContainText("8.45");
  await expect(totalDriverRow).toContainText("8.45");

  // Click the value, enter 8.50, save.
  await page.getByTestId(`button-edit-day-total-${PUNCH_DATE}`).click();
  const input = page.getByTestId(`input-day-total-${PUNCH_DATE}`);
  await input.fill("8.50");
  await page.getByTestId(`button-save-day-total-${PUNCH_DATE}`).click();
  await expect(input).toHaveCount(0);
  await expect(dayRow).toContainText("8.50");
  await expect(totalDriverRow).toContainText("8.50");

  // DB sanity: each punch is marked edited and their hours sum to 8.50.
  const after = await pool.query<{ hours: string; edited: boolean }>(
    `SELECT hours::text, edited FROM punches
       WHERE week_start = $1 AND kfi_id = $2 ORDER BY id ASC`,
    [WEEK_START, DRIVER.kfiId],
  );
  expect(after.rows).toHaveLength(2);
  const sum = after.rows.reduce((s, r) => s + Number(r.hours), 0);
  expect(Math.abs(sum - 8.5)).toBeLessThan(0.005);
  for (const r of after.rows) expect(r.edited).toBe(true);

  // Reset puts it back to the engine-derived 8.45 (clock-in/out diff).
  await page.getByTestId(`button-reset-day-total-${PUNCH_DATE}`).click();
  await expect(dayRow).toContainText("8.45");
  await expect(totalDriverRow).toContainText("8.45");
});
