/**
 * End-to-end coverage for the "Differs from Connecteam" parity badge after
 * task #221 changed the rule to compare
 * `(Connecteam snapshot + Customer-imported hours)` per day against the
 * dashboard's per-day total (instead of CT vs Dashboard alone).
 *
 * Seeds a driver-week where:
 *   - 2031-05-05 (Mon): CT 6h + Customer 2h = 8h, Dashboard 8h    → match
 *   - 2031-05-06 (Tue): CT 5h + Customer 2h = 7h, Dashboard 9h    → diff
 *     (an extra Driver punch crept in; the two source documents combined
 *     don't add up to what we're about to pay — exactly the case the
 *     reworked badge is supposed to catch)
 *
 * Asserts the badge reads "Differs from Connecteam (1)" and the tooltip
 * shows all three numbers (CT, Customer, Dashboard) for the offending day.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the ct-customer-parity e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-05-04"; // Sunday
const WEEK_END = "2031-05-10";

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const KFI_ID = `KFI-CP-${SUFFIX}`;
const DRIVER_NAME = "CT Parity Driver";
const CUSTOMER = "Adient";

// Day 1 (Mon 5/5): CT 6h + Customer 2h, dashboard total 8h → match.
// Day 2 (Tue 5/6): CT 5h + Customer 2h, but Driver-side has BOTH the
//   original 5h CT-sourced shift AND a 2h manual Driver punch. Dashboard
//   total = 5+2+2 = 9h. CT snapshot still shows 5h (snapshot was taken
//   before the manual punch), Customer file still shows 2h. Sum = 7 ≠ 9 →
//   the day must surface as a diff.
const PUNCHES = [
  {
    date: "2031-05-05",
    clockIn: "2031-05-05 8:00 AM",
    clockOut: "2031-05-05 2:00 PM",
    hours: 6,
    source: "Driver" as const,
  },
  {
    date: "2031-05-05",
    clockIn: "2031-05-05 3:00 PM",
    clockOut: "2031-05-05 5:00 PM",
    hours: 2,
    source: "Customer" as const,
  },
  {
    date: "2031-05-06",
    clockIn: "2031-05-06 8:00 AM",
    clockOut: "2031-05-06 1:00 PM",
    hours: 5,
    source: "Driver" as const,
  },
  {
    date: "2031-05-06",
    clockIn: "2031-05-06 2:00 PM",
    clockOut: "2031-05-06 4:00 PM",
    hours: 2,
    source: "Customer" as const,
  },
  {
    // Manual Driver punch that pushes dashboard above CT+Customer.
    date: "2031-05-06",
    clockIn: "2031-05-06 5:00 PM",
    clockOut: "2031-05-06 7:00 PM",
    hours: 2,
    source: "Driver" as const,
  },
];

// Snapshot the CT-side baseline as if /refresh-connecteam ran BEFORE the
// dispatcher added the manual punch on 5/6. Day 1 CT=6, Day 2 CT=5.
const SNAPSHOT = [
  { date: "2031-05-05", hours: "6.00" },
  { date: "2031-05-06", hours: "5.00" },
];

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO weeks (start_date, end_date, last_refreshed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (start_date) DO UPDATE
         SET end_date = EXCLUDED.end_date,
             last_refreshed_at = EXCLUDED.last_refreshed_at`,
      [WEEK_START, WEEK_END],
    );
    await client.query(
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
      [KFI_ID, DRIVER_NAME, CUSTOMER],
    );
    for (const p of PUNCHES) {
      await client.query(
        `INSERT INTO punches
           (week_start, kfi_id, customer, source, date,
            clock_in, clock_out, hours, is_manual)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          WEEK_START,
          KFI_ID,
          CUSTOMER,
          p.source,
          p.date,
          p.clockIn,
          p.clockOut,
          p.hours,
        ],
      );
    }
    for (const s of SNAPSHOT) {
      await client.query(
        `INSERT INTO connecteam_daily_snapshots
           (week_start, kfi_id, date, hours)
         VALUES ($1::date, $2, $3::date, $4::numeric)
         ON CONFLICT (week_start, kfi_id, date) DO UPDATE
           SET hours = EXCLUDED.hours`,
        [WEEK_START, KFI_ID, s.date, s.hours],
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
  await pool.query(
    `DELETE FROM connecteam_daily_snapshots WHERE week_start = $1`,
    [WEEK_START],
  );
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
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

test("parity badge flags days where (CT + Customer) != Dashboard, with all three numbers in the tooltip", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${KFI_ID}`);
  await expect(
    page.getByRole("heading", { name: DRIVER_NAME }),
  ).toBeVisible();

  // Badge text: 1 day diverges (Tue 5/6), Mon matches.
  const badge = page.getByTestId("badge-ct-parity-diff");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Differs from Connecteam (1)");

  // Tooltip surfaces CT + Customer = Sum vs Dashboard for the diff day.
  // The badge uses the native `title` attribute, so assert against that.
  const title = await badge.getAttribute("title");
  expect(title).not.toBeNull();
  expect(title!).toContain("2031-05-06");
  expect(title!).toContain("CT 5.00h");
  expect(title!).toContain("Customer 2.00h");
  expect(title!).toContain("= 7.00h");
  expect(title!).toContain("Dashboard 9.00h");
  // Mon (the matching day) should NOT appear in the diff list.
  expect(title!).not.toContain("2031-05-05");

  // Also assert the underlying API returns the new shape so a regression in
  // the OpenAPI schema (and codegen) would be caught here too.
  const apiRes = await page.request.get(
    `/api/weeks/${WEEK_START}/drivers/${KFI_ID}`,
  );
  expect(apiRes.status()).toBe(200);
  const body = await apiRes.json();
  expect(body.connecteamParity.status).toBe("differ");
  expect(body.connecteamParity.diffCount).toBe(1);
  const day = body.connecteamParity.days.find(
    (d: { date: string }) => d.date === "2031-05-06",
  );
  expect(day).toMatchObject({
    connecteamHours: 5,
    customerHours: 2,
    dashboardHours: 9,
    matches: false,
  });
});
