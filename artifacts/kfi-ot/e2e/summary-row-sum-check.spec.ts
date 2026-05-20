/**
 * End-to-end coverage for the "Total = sum of punch rows" check added in
 * task #397 to the driver-detail Summary/Checks panels.
 *
 * The pure helper (`artifacts/kfi-ot/src/lib/summaryChecks.ts`) is unit-
 * tested in `summaryChecks.test.ts`. This spec locks in the UI-side wiring
 * the unit test cannot see:
 *   - the new `row-check-total-row-sum` row actually renders in the
 *     Checks card with the dispatcher's row-hours total,
 *   - the card stays green ("Checks — all reconcile") when the per-row
 *     hours column agrees with the engine's Total Hours,
 *   - the row turns warning-orange and the card flips to "Checks — mismatch"
 *     when the two diverge (simulated here by intercepting the API response
 *     and editing one punch's `hours` field client-side, so the engine
 *     total and the rendered row sum drift apart deterministically).
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

// Pick a Sunday far enough in the future that it does not collide with
// real dispatcher data and is distinct from the other e2e specs.
const WEEK_START = "2031-05-04";
const WEEK_END = "2031-05-10";

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const KFI_ID = `KFI-RS-${SUFFIX}`;
const DRIVER_NAME = "Row Sum Check Driver";
const CUSTOMER = "Adient";

// Three punches whose hours sum cleanly to the engine total. Same shape as
// the Tiana scenario used by summary-checks.spec.ts, so any drift in row
// alignment shows up there too.
const PUNCHES = [
  {
    date: "2031-05-05",
    clockIn: "2031-05-05 8:00 AM",
    clockOut: "2031-05-06 7:23 PM",
    hours: 35.39,
    source: "Customer" as const,
  },
  {
    date: "2031-05-08",
    clockIn: "2031-05-08 9:00 AM",
    clockOut: "2031-05-08 3:32 PM",
    hours: 6.54,
    source: "Driver" as const,
  },
  {
    date: "2031-05-09",
    clockIn: "2031-05-09 10:00 AM",
    clockOut: "2031-05-09 10:41 PM",
    hours: 12.68,
    source: "Customer" as const,
  },
];

const TOTAL_HOURS = 54.61; // 35.39 + 6.54 + 12.68

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
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("row-sum check renders, reconciles, and shows the row-hours total", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${KFI_ID}`);
  await expect(
    page.getByRole("heading", { name: DRIVER_NAME }),
  ).toBeVisible();

  const checks = page.getByTestId("card-checks");
  await expect(checks).toBeVisible();

  // The new row is present and shows the rendered row-hours total (which
  // equals Total Hours when there is no drift).
  const rowSum = checks.getByTestId("row-check-total-row-sum");
  await expect(rowSum).toBeVisible();
  await expect(rowSum).toContainText("Total = sum of punch rows");
  await expect(rowSum).toContainText(TOTAL_HOURS.toFixed(2));

  // The row renders its own passing-state check icon (emerald), not the
  // warning X — locks in the per-row icon-swap branch in SummaryAndChecks.
  await expect(
    rowSum.locator("svg.text-emerald-600, svg.dark\\:text-emerald-400"),
  ).toHaveCount(1);
  await expect(rowSum.locator("dd")).not.toHaveClass(/text-warning/);

  // Card header reads "all reconcile" — i.e. every check, including the
  // new row-sum one, passes.
  await expect(checks).toContainText("all reconcile");
  await expect(checks).not.toContainText("mismatch");
});

test("row-sum check flips the card to mismatch and warns when rows diverge from Total Hours", async ({
  page,
}) => {
  // Intercept the driver-detail fetch and edit one punch's `hours` value so
  // the dispatcher-visible row sum (49.22) drifts from the engine total
  // (54.61) by well over the 0.015 tolerance.
  await page.route(
    `**/api/weeks/${WEEK_START}/drivers/${KFI_ID}`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (Array.isArray(body?.punches) && body.punches.length > 0) {
        // Knock 5.39h off the first Customer punch so the rendered hours
        // column no longer adds up to totals.totalHours.
        body.punches[0].hours = 30;
      }
      await route.fulfill({
        response,
        json: body,
      });
    },
  );

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${KFI_ID}`);
  await expect(
    page.getByRole("heading", { name: DRIVER_NAME }),
  ).toBeVisible();

  const checks = page.getByTestId("card-checks");
  await expect(checks).toBeVisible();

  // The card header flips to "mismatch" as soon as any check fails.
  await expect(checks).toContainText("mismatch");
  await expect(checks).not.toContainText("all reconcile");

  // The row-sum row is the one that broke: it renders the *actual* row
  // total (30 + 6.54 + 12.68 = 49.22), and its value cell carries the
  // warning styling (text-warning + font-mono).
  const rowSum = checks.getByTestId("row-check-total-row-sum");
  await expect(rowSum).toBeVisible();
  await expect(rowSum).toContainText("Total = sum of punch rows");
  const valueCell = rowSum.locator("dd");
  await expect(valueCell).toHaveText("49.22");
  await expect(valueCell).toHaveClass(/font-mono/);
  await expect(valueCell).toHaveClass(/text-warning/);

  // The other six identity checks are unaffected — totals.totalHours,
  // totals.driverHours, totals.customerHours, and the per-source RT/OT
  // buckets still all reconcile against each other.
  for (const slug of [
    "row-check-total-driver-customer",
    "row-check-customer-total-driver",
    "row-check-driver-total-customer",
    "row-check-rt-min-total-40-",
    "row-check-ot-max-0-total-40-",
    "row-check-rt-ot-total",
  ]) {
    const row = checks.getByTestId(slug);
    await expect(row).toBeVisible();
    // Passing rows do NOT get the text-warning class on their value cell.
    await expect(row.locator("dd")).not.toHaveClass(/text-warning/);
  }
});
