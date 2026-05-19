/**
 * End-to-end coverage for the per-punch reviewed checkbox on the driver-
 * detail page. Verifies:
 *   1. Toggling a punch checkbox updates the per-day and per-week counters.
 *   2. The state persists across page reloads (server-side stamped).
 *   3. Editing the punch (changing clockIn) auto-clears the reviewed flag.
 *   4. Locking the driver-week disables the checkbox and the API returns 423.
 *
 * Seeds an isolated week with a couple of punches via direct DB writes and
 * cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the punch-reviewed e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-04-21";
const WEEK_END = "2031-04-27";
const SUFFIX = `e2e-pr-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-PR1-${SUFFIX}`,
  name: "AAA Punch Reviewed",
  customer: "Adient",
};

type SeededPunch = { id: number; date: string };

async function seed(): Promise<SeededPunch[]> {
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
    const rows: SeededPunch[] = [];
    const punchSpecs = [
      { date: WEEK_START, ci: "8:00 AM", co: "12:00 PM", h: 4.0 },
      { date: WEEK_START, ci: "1:00 PM", co: "5:00 PM", h: 4.0 },
      { date: "2031-04-22", ci: "7:30 AM", co: "11:30 AM", h: 4.0 },
    ];
    for (const s of punchSpecs) {
      const r = await client.query(
        `INSERT INTO punches
           (week_start, kfi_id, customer, source, date,
            clock_in, clock_out, hours, is_manual)
         VALUES ($1::date, $2, $3, 'Driver', $4,
                 $5, $6, $7, true)
         RETURNING id, date`,
        [
          WEEK_START,
          DRIVER.kfiId,
          DRIVER.customer,
          s.date,
          `${s.date} ${s.ci}`,
          `${s.date} ${s.co}`,
          s.h,
        ],
      );
      rows.push({ id: r.rows[0].id, date: r.rows[0].date });
    }
    await client.query("COMMIT");
    return rows;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [DRIVER.kfiId]);
}

let seededPunches: SeededPunch[] = [];

test.beforeAll(async () => {
  await cleanup();
  seededPunches = await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("per-punch reviewed checkbox updates counters, persists, auto-clears on edit, and respects locks", async ({
  page,
}) => {
  await page.goto("/");
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`);
  await expect(
    page.getByRole("heading", { name: DRIVER.name }),
  ).toBeVisible({ timeout: 15000 });

  const weekPill = page.getByTestId("pill-punch-reviewed-progress");
  const firstPunch = seededPunches[0];
  const secondPunch = seededPunches[1];
  const thirdPunch = seededPunches[2];
  const cb1 = page.getByTestId(`checkbox-punch-reviewed-${firstPunch.id}`);
  const cb2 = page.getByTestId(`checkbox-punch-reviewed-${secondPunch.id}`);
  const cb3 = page.getByTestId(`checkbox-punch-reviewed-${thirdPunch.id}`);
  const day1Badge = page.getByTestId(`day-reviewed-count-${WEEK_START}`);
  const day2Badge = page.getByTestId(`day-reviewed-count-2031-04-22`);

  // Baseline: nothing reviewed yet.
  await expect(weekPill).toContainText("0/3 punches");
  await expect(day1Badge).toHaveText("0/2");
  await expect(day2Badge).toHaveText("0/1");
  await expect(cb1).toHaveAttribute("data-state", "unchecked");

  // 1. Toggle first punch reviewed: counters update.
  await cb1.click();
  await expect(cb1).toHaveAttribute("data-state", "checked");
  await expect(day1Badge).toHaveText("1/2");
  await expect(weekPill).toContainText("1/3 punches");

  // 2. Toggle other two reviewed too: week counter shows fully done.
  await cb2.click();
  await cb3.click();
  await expect(day1Badge).toHaveText("2/2");
  await expect(day2Badge).toHaveText("1/1");
  await expect(weekPill).toContainText("3/3 punches");

  // 3. Reload — state persists from the server.
  await page.reload();
  await expect(
    page.getByTestId(`checkbox-punch-reviewed-${firstPunch.id}`),
  ).toHaveAttribute("data-state", "checked");
  await expect(
    page.getByTestId(`day-reviewed-count-${WEEK_START}`),
  ).toHaveText("2/2");
  await expect(
    page.getByTestId("pill-punch-reviewed-progress"),
  ).toContainText("3/3 punches");

  // 4. Auto-clear: edit the first punch's clock-in. The PATCH should null
  //    reviewedAt and the checkbox flips back to unchecked after refetch.
  await page
    .getByTestId(`button-edit-punch-${firstPunch.id}`)
    .click();
  const inIn = page.getByTestId(`input-edit-clock-in-${firstPunch.id}`);
  await inIn.fill("8:15 AM");
  await page.getByTestId(`button-save-punch-${firstPunch.id}`).click();
  await expect(
    page.getByTestId(`checkbox-punch-reviewed-${firstPunch.id}`),
  ).toHaveAttribute("data-state", "unchecked");
  await expect(
    page.getByTestId(`day-reviewed-count-${WEEK_START}`),
  ).toHaveText("1/2");
  await expect(
    page.getByTestId("pill-punch-reviewed-progress"),
  ).toContainText("2/3 punches");

  // 5. Locked driver-week: API returns 423 on the reviewed PUT.
  await pool.query(
    `INSERT INTO reviewed_drivers (week_start, kfi_id, locked_at)
     VALUES ($1::date, $2, now())
     ON CONFLICT (week_start, kfi_id) DO UPDATE SET locked_at = now()`,
    [WEEK_START, DRIVER.kfiId],
  );
  const lockedResp = await page.request.put(
    `/api/punches/${secondPunch.id}/reviewed`,
    { data: { reviewed: false } },
  );
  expect(lockedResp.status()).toBe(423);
});
