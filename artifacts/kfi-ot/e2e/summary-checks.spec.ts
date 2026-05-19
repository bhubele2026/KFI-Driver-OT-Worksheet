/**
 * End-to-end coverage for the Summary and Checks panels on the per-driver
 * page (artifacts/kfi-ot/src/pages/driver-detail.tsx — SummaryAndChecks).
 *
 * Mirrors the "Tiana" scenario from
 * artifacts/api-server/src/lib/__tests__/hoursEngine.test.ts:
 *   Customer 35.39h → Driver 6.54h → Customer 12.68h, chronologically.
 * The Driver shift straddles the 40h boundary, so:
 *   Total Driver   6.54
 *   Total Customer 48.07
 *   RT             40.00
 *   OT             14.61
 *   Driver RT       4.61
 *   Driver OT       1.93
 * and the Checks panel must render its green "all reconcile" state.
 *
 * Seeds an isolated week via direct DB writes so the test doesn't depend on
 * existing data, and cleans up afterwards.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the summary-checks e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Pick a Sunday far enough in the future that it does not collide with real
// dispatcher data (and a different week than the other e2e specs use).
const WEEK_START = "2031-04-06";
const WEEK_END = "2031-04-12";

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const KFI_ID = `KFI-SC-${SUFFIX}`;
const DRIVER_NAME = "Summary Checks Driver";
const CUSTOMER = "Adient";

// Three punches, in chronological order:
//   Mon 35.39h Customer  → running 0   → 35.39
//   Thu  6.54h Driver    → running 35.39 → 41.93 (crosses 40)
//   Fri 12.68h Customer  → running 41.93 → 54.61 (all OT)
const PUNCHES = [
  {
    date: "2031-04-07",
    clockIn: "2031-04-07 8:00 AM",
    clockOut: "2031-04-08 7:23 PM",
    hours: 35.39,
    source: "Customer" as const,
  },
  {
    date: "2031-04-10",
    clockIn: "2031-04-10 9:00 AM",
    clockOut: "2031-04-10 3:32 PM",
    hours: 6.54,
    source: "Driver" as const,
  },
  {
    date: "2031-04-11",
    clockIn: "2031-04-11 10:00 AM",
    clockOut: "2031-04-11 10:41 PM",
    hours: 12.68,
    source: "Customer" as const,
  },
];

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
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [KFI_ID]);
}

test.beforeAll(async () => {
  await cleanup(); // defensive — ignore prior partial runs
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("Summary and Checks panels render the per-source split and reconcile", async ({
  page,
}) => {
  // Trigger the dev auth bypass via the root, then land on the driver page.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto(`/weeks/${WEEK_START}/drivers/${KFI_ID}`);
  await expect(
    page.getByRole("heading", { name: DRIVER_NAME }),
  ).toBeVisible();

  const summary = page.getByTestId("card-summary");
  await expect(summary).toBeVisible();

  // Each row renders "<label> <value.toFixed(2)>" — assert the value half.
  const expectValue = async (testId: string, expected: string) => {
    await expect(summary.getByTestId(testId)).toContainText(expected);
  };
  await expectValue("row-summary-total-driver", "6.54");
  await expectValue("row-summary-total-customer", "48.07");
  await expectValue("row-summary-rt", "40.00");
  await expectValue("row-summary-ot", "14.61");
  await expectValue("row-summary-driver-rt", "4.61");
  await expectValue("row-summary-driver-ot", "1.93");

  // Checks panel shows the green "all reconcile" header.
  const checks = page.getByTestId("card-checks");
  await expect(checks).toBeVisible();
  await expect(checks).toContainText("all reconcile");

  // Each individual check row should be present (and, by virtue of the
  // header reading "all reconcile", passing).
  for (const slug of [
    "row-check-total-driver-customer",
    "row-check-customer-total-driver",
    "row-check-driver-total-customer",
    "row-check-rt-min-total-40-",
    "row-check-ot-max-0-total-40-",
    "row-check-rt-ot-total",
  ]) {
    await expect(checks.getByTestId(slug)).toBeVisible();
  }
});
