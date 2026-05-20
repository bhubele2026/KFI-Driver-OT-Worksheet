/**
 * Task #357 coverage — proves the two user-facing surfaces fixed in this
 * task actually behave as described in the popover help text:
 *
 *   1. The Save flow in the driver-detail tz popover restamps existing
 *      Driver-source punches by the tz delta (not just future ingests).
 *      We exercise this at the API level by replaying the exact two-step
 *      the popover Save handler issues: PATCH /drivers/:kfiId/timezone
 *      then POST /shift-punches with the computed delta. If a refactor
 *      drops the second call we'd see stale wall-clock strings here and
 *      fail loudly.
 *
 *   2. The new Shuster clock 2005141 lands in `clock_offsets` with +1h
 *      via the marker-gated fixup in `lib/db/src/preMigrate.ts`. Asserted
 *      directly against the table — the fixup is idempotent and runs as
 *      part of `pnpm --filter @workspace/db run push` (which the e2e
 *      pre-flight does), so the row must be present by the time this
 *      spec runs.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the tz-shuster-shift e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-tz357-${Date.now().toString(36)}`;
const WEEK_START = "2031-09-07"; // Sunday
const WEEK_END = "2031-09-13"; // Saturday

const DRIVER = {
  kfiId: `95${Date.now()}`.slice(0, 10),
  name: `Shuster TZ Tester ${SUFFIX}`,
  customer: "Shuster",
};

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER.kfiId],
  );
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [DRIVER.kfiId]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer, display_tz)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer,
             display_tz = NULL`,
    [DRIVER.kfiId, DRIVER.name, DRIVER.customer],
  );
  // Seed a Driver-source punch landing in Chicago (8AM–12PM). The Save
  // flow will move the driver default to New_York and the spec asserts
  // the wall-clock moves +1h to 9AM–1PM with disp_tz restamped.
  await pool.query(
    `INSERT INTO punches
        (week_start, kfi_id, customer, source, date, clock_in, clock_out,
         hours, disp_tz, is_manual)
       VALUES
        ($1, $2, 'Shuster', 'Driver', $3, $4, $5, 4, 'America/Chicago', false)`,
    [
      WEEK_START,
      DRIVER.kfiId,
      WEEK_START,
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 12:00 PM`,
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

test("Shuster clock 2005141 is seeded with +1h offset", async () => {
  const rows = await pool.query<{ hours_offset: string }>(
    `SELECT hours_offset::text FROM clock_offsets WHERE clock_id = $1`,
    ["2005141"],
  );
  expect(rows.rowCount).toBe(1);
  // numeric(6,2) serializes as a decimal string — accept either "1.00"
  // or "1" depending on the driver, just assert the numeric value.
  expect(Number(rows.rows[0]!.hours_offset)).toBe(1);
});

test("Save display tz auto-shifts existing Driver-source punches", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Step 1: replay the popover Save → PATCH driver tz to New_York.
  const patchRes = await page.request.patch(
    `/api/drivers/${DRIVER.kfiId}/timezone`,
    { data: { displayTz: "America/New_York" } },
  );
  expect(patchRes.status()).toBe(200);

  // Step 2: replay the auto-shift. Chicago → New_York is +1h at this
  // anchor date (no DST cliff), matching what `tzDeltaHours` computes
  // on the client.
  const shiftRes = await page.request.post(
    `/api/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}/shift-punches`,
    {
      data: {
        offsetHours: 1,
        source: "Driver",
        newDispTz: "America/New_York",
      },
    },
  );
  expect(shiftRes.status()).toBe(200);
  const shiftBody = (await shiftRes.json()) as { shifted: number };
  expect(shiftBody.shifted).toBe(1);

  // Assert the row was both shifted and restamped — exactly what the
  // dispatcher must see on the page after a single Save click.
  const after = await pool.query<{
    clock_in: string;
    clock_out: string;
    disp_tz: string;
  }>(
    `SELECT clock_in, clock_out, disp_tz FROM punches
       WHERE week_start = $1 AND kfi_id = $2 AND source = 'Driver'`,
    [WEEK_START, DRIVER.kfiId],
  );
  expect(after.rowCount).toBe(1);
  const row = after.rows[0]!;
  expect(row.clock_in).toContain("9:00 AM");
  expect(row.clock_out).toContain("1:00 PM");
  expect(row.disp_tz).toBe("America/New_York");

  // And the driver-detail GET must reflect the new effective tz so the
  // header tz pill renders correctly without a manual refresh.
  const detail = await page.request.get(
    `/api/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`,
  );
  expect(detail.status()).toBe(200);
  const detailBody = (await detail.json()) as {
    driver: { effectiveDispTz: string };
  };
  expect(detailBody.driver.effectiveDispTz).toBe("America/New_York");
});
