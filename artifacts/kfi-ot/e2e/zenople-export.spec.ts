/**
 * End-to-end coverage for the Zenople export flow:
 *   1. With an incomplete profile (missing pay rate), clicking the "Export to
 *      Zenople" button opens the "Not ready" dialog listing the offending
 *      driver and surfaces the missing fields.
 *   2. After filling in the missing pay rate via the per-driver "Pay & bill
 *      rates" card and marking the driver reviewed, the same export button
 *      downloads a valid xlsx file with the expected header.
 *
 * Seeds an isolated week + driver + a partial payroll profile via direct DB
 * writes; cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the zenople-export e2e test.");
}
const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-05-04";
const WEEK_END = "2031-05-10";
const SUFFIX = `e2e-zen-${Date.now().toString(36)}`;
const KFI_ID = `KFI-Z1-${SUFFIX}`;
const NAME = "ZZZ Zenople Driver";

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
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, 'Adient')
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
      [KFI_ID, NAME],
    );
    await client.query(
      `INSERT INTO punches
         (week_start, kfi_id, customer, source, date,
          clock_in, clock_out, hours, is_manual)
       VALUES ($1::date, $2, 'Adient', 'Customer', $1,
               $3, $4, 8.0, true)`,
      [
        WEEK_START,
        KFI_ID,
        `${WEEK_START} 8:00 AM`,
        `${WEEK_START} 4:00 PM`,
      ],
    );
    // Partial profile — missing rtPayRate so readiness fails.
    await client.query(
      `INSERT INTO driver_payroll_profiles
         (kfi_id, ssn, job_id, person_id, assignment_id, zenople_customer,
          rt_bill_rate, ot_pay_rate, ot_bill_rate,
          driver_rt_pay_rate, driver_rt_bill_rate,
          driver_ot_pay_rate, driver_ot_bill_rate)
       VALUES ($1, 'XXX-XX-9999', 558, 9999999, 9999, 'Adient',
               25.37, 27.38, 37.24,
               13.75, 0,
               27.38, 0)
       ON CONFLICT (kfi_id) DO UPDATE SET
         ssn = EXCLUDED.ssn,
         job_id = EXCLUDED.job_id,
         person_id = EXCLUDED.person_id,
         assignment_id = EXCLUDED.assignment_id,
         zenople_customer = EXCLUDED.zenople_customer,
         rt_pay_rate = NULL,
         rt_bill_rate = EXCLUDED.rt_bill_rate,
         ot_pay_rate = EXCLUDED.ot_pay_rate,
         ot_bill_rate = EXCLUDED.ot_bill_rate,
         driver_rt_pay_rate = EXCLUDED.driver_rt_pay_rate,
         driver_rt_bill_rate = EXCLUDED.driver_rt_bill_rate,
         driver_ot_pay_rate = EXCLUDED.driver_ot_pay_rate,
         driver_ot_bill_rate = EXCLUDED.driver_ot_bill_rate`,
      [KFI_ID],
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
  await pool.query(`DELETE FROM driver_payroll_profiles WHERE kfi_id = $1`, [
    KFI_ID,
  ]);
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [KFI_ID]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("Not-ready dialog lists missing-profile driver; after filling the rate and reviewing, export downloads a valid xlsx", async ({
  page,
}) => {
  // Trigger dev auth bypass so the user is admin.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.goto(`/weeks/${WEEK_START}`);

  const exportButton = page.getByTestId("button-zenople-export");
  await expect(exportButton).toBeVisible();

  // 1. Click while unreviewed + incomplete profile -> dialog appears.
  await exportButton.click();
  const dialog = page.getByTestId("dialog-zenople-not-ready");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(KFI_ID);
  await expect(dialog).toContainText("rtPayRate");
  await page.getByTestId("button-zenople-not-ready-close").click();

  // 2. Navigate to driver detail and fill the missing rate via the admin
  //    "Pay & bill rates" card.
  await page.goto(`/weeks/${WEEK_START}/drivers/${KFI_ID}`);
  await page.getByTestId("button-edit-payroll-profile").click();
  await page.getByTestId("input-payroll-rtPayRate").fill("18.25");
  await page.getByTestId("button-save-payroll-profile").click();
  // Wait for save to settle: button-edit returns after save flips editing=false
  await expect(page.getByTestId("button-edit-payroll-profile")).toBeVisible();

  // Mark this driver reviewed via the header checkbox.
  await page.locator("#reviewed").click();
  await expect(page.locator("#reviewed")).toHaveAttribute(
    "data-state",
    "checked",
  );

  // 3. Back on the week dashboard, click Export -> expect a real download.
  await page.goto(`/weeks/${WEEK_START}`);
  await expect(page.getByTestId("button-zenople-export")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("button-zenople-export").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^Driver_Pay_Units_customer_and_Driver_time_PD_\d{2}\.\d{2}\.\d{4}_\d+\.xlsx$/,
  );
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });
  // Header preserved verbatim with literal leading spaces on the last 3.
  expect(aoa[0][14]).toBe(" End Date");
  expect(aoa[0][15]).toBe(" Status");
  expect(aoa[0][16]).toBe(" Assignment Id");
  // Driver row present — 8h Customer punch -> RT row, payUnit 8.
  const rtRow = aoa.find((r) => r && r[5] === "RT");
  expect(rtRow).toBeDefined();
  expect(rtRow![6]).toBe(8);
});
