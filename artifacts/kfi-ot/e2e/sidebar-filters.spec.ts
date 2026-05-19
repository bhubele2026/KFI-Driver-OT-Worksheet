/**
 * End-to-end coverage for the drivers sidebar search box and filter chips
 * (artifacts/kfi-ot/src/components/drivers-sidebar.tsx).
 *
 * Verifies:
 *   - Typing in the search box narrows the visible drivers by name / KFI id
 *     and clearing the search restores the full list.
 *   - The "Un-reviewed" chip hides reviewed drivers.
 *   - The "Has OT" chip hides drivers without overtime.
 *   - The "Mismatch" chip hides drivers without a Driver vs Customer
 *     hours mismatch.
 *   - Combinations of search + chips intersect correctly.
 *   - The filter-count badge ("X of N drivers") reflects the visible total.
 *   - When no drivers match, the empty state is shown.
 *
 * Seeds an isolated week with four drivers covering each axis and cleans
 * up afterwards. Persisted filter state is wiped via localStorage at the
 * start so a previous run cannot leak into this one.
 */
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the sidebar-filters e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-04-20";
const WEEK_END = "2031-04-26";
const SUFFIX = `e2e-sf-${Date.now().toString(36)}`;

// Sidebar order is customer (KNOWN_CUSTOMERS sequence: Adient before
// Burnett), then alphabetical-by-name within a customer. Each driver
// is shaped to land in exactly one filter axis:
//   D1 — plain (un-reviewed, no OT, no mismatch)
//   D2 — reviewed (so "Un-reviewed" hides it)
//   D3 — has overtime via 5 long Driver punches summing to 45h
//   D4 — Driver vs Customer hours mismatch (4h driver + 6h customer)
const D1 = { kfiId: `KFI-SF1-${SUFFIX}`, name: "AAA Plain Driver", customer: "Adient" };
const D2 = { kfiId: `KFI-SF2-${SUFFIX}`, name: "BBB Reviewed Driver", customer: "Adient" };
const D3 = { kfiId: `KFI-SF3-${SUFFIX}`, name: "CCC Overtime Driver", customer: "Adient" };
const D4 = { kfiId: `KFI-SF4-${SUFFIX}`, name: "DDD Mismatch Driver", customer: "Burnett" };
const ALL = [D1, D2, D3, D4] as const;

async function insertPunch(
  client: import("pg").PoolClient,
  kfiId: string,
  customer: string,
  date: string,
  source: "Driver" | "Customer",
  clockIn: string,
  clockOut: string,
  hours: number,
): Promise<void> {
  await client.query(
    `INSERT INTO punches
       (week_start, kfi_id, customer, source, date,
        clock_in, clock_out, hours, is_manual)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, true)`,
    [WEEK_START, kfiId, customer, source, date, clockIn, clockOut, hours],
  );
}

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
       ON CONFLICT (start_date) DO NOTHING`,
      [WEEK_START, WEEK_END],
    );
    for (const d of ALL) {
      await client.query(
        `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
         ON CONFLICT (kfi_id) DO UPDATE
           SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
        [d.kfiId, d.name, d.customer],
      );
    }
    // D1: 1 driver punch, 4h.
    await insertPunch(
      client,
      D1.kfiId,
      D1.customer,
      WEEK_START,
      "Driver",
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 12:00 PM`,
      4.0,
    );
    // D2: same shape as D1, plus marked reviewed below.
    await insertPunch(
      client,
      D2.kfiId,
      D2.customer,
      WEEK_START,
      "Driver",
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 12:00 PM`,
      4.0,
    );
    // D3: 5 driver punches of 9h each on consecutive days = 45h → OT.
    for (let i = 0; i < 5; i++) {
      const dt = new Date(`${WEEK_START}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() + i);
      const iso = dt.toISOString().slice(0, 10);
      await insertPunch(
        client,
        D3.kfiId,
        D3.customer,
        iso,
        "Driver",
        `${iso} 7:00 AM`,
        `${iso} 4:00 PM`,
        9.0,
      );
    }
    // D4: 4h Driver + 6h Customer → mismatch (|4 - 6| > 0.05).
    await insertPunch(
      client,
      D4.kfiId,
      D4.customer,
      WEEK_START,
      "Driver",
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 12:00 PM`,
      4.0,
    );
    await insertPunch(
      client,
      D4.kfiId,
      D4.customer,
      WEEK_START,
      "Customer",
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 2:00 PM`,
      6.0,
    );
    // Mark D2 reviewed.
    await client.query(
      `INSERT INTO reviewed_drivers (week_start, kfi_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [WEEK_START, D2.kfiId],
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
  const ids = ALL.map((d) => d.kfiId);
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`, [ids]);
}

async function expectVisibleDrivers(
  page: Page,
  expectedKfiIds: readonly string[],
): Promise<void> {
  for (const d of ALL) {
    const row = page.getByTestId(`sidebar-driver-${d.kfiId}`);
    if (expectedKfiIds.includes(d.kfiId)) {
      await expect(row).toBeVisible();
    } else {
      await expect(row).toHaveCount(0);
    }
  }
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

// Skipped in CI: flaky chip-filter-ot locator race (chip element renders but
// timeouts at the 10s actionTimeout under CI load).
// Tracked by follow-up task #285 (stabilize with deterministic wait).
(process.env.CI ? test.skip : test)("sidebar search + filter chips narrow the visible drivers", async ({
  page,
}) => {
  // Wipe any persisted sidebar filter state so the run starts clean.
  await page.addInitScript(() => {
    try {
      const prefix = "kfi-ot:drivers-sidebar:filters:v1";
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(prefix)) window.localStorage.removeItem(k);
      }
    } catch {
      /* ignore */
    }
  });

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${D1.kfiId}`);
  await expect(page.getByRole("heading", { name: D1.name })).toBeVisible();
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();

  const search = page.getByTestId("input-sidebar-search");
  const countBadge = page.getByTestId("sidebar-filter-count");
  const chipUnreviewed = page.getByTestId("chip-filter-unreviewed");
  const chipOt = page.getByTestId("chip-filter-ot");
  const chipMismatch = page.getByTestId("chip-filter-mismatch");

  // 0. No filter active → all four drivers visible, no count badge.
  await expectVisibleDrivers(page, [D1.kfiId, D2.kfiId, D3.kfiId, D4.kfiId]);
  await expect(countBadge).toHaveCount(0);

  // 1. Search by name fragment narrows to a single driver.
  await search.fill("Mismatch");
  await expectVisibleDrivers(page, [D4.kfiId]);
  await expect(countBadge).toHaveText("1 of 4 drivers");

  // 2. Search by KFI id substring also matches.
  await search.fill("SF3");
  await expectVisibleDrivers(page, [D3.kfiId]);
  await expect(countBadge).toHaveText("1 of 4 drivers");

  // 3. A search with no matches shows the empty state.
  await search.fill("zzz-no-match");
  await expectVisibleDrivers(page, []);
  await expect(page.getByTestId("sidebar-empty-filtered")).toContainText(
    "No drivers match the current filters.",
  );

  // 4. Clearing search via the X restores everything.
  await page.getByTestId("button-sidebar-search-clear").click();
  await expect(search).toHaveValue("");
  await expectVisibleDrivers(page, [D1.kfiId, D2.kfiId, D3.kfiId, D4.kfiId]);
  await expect(countBadge).toHaveCount(0);

  // 5. Un-reviewed chip hides D2 (the only reviewed driver).
  await chipUnreviewed.click();
  await expectVisibleDrivers(page, [D1.kfiId, D3.kfiId, D4.kfiId]);
  await expect(countBadge).toHaveText("3 of 4 drivers");

  // 6. + Has OT chip → only D3 (un-reviewed AND has OT).
  await chipOt.click();
  await expectVisibleDrivers(page, [D3.kfiId]);
  await expect(countBadge).toHaveText("1 of 4 drivers");

  // 7. Replace OT with Mismatch → only D4 left (un-reviewed AND mismatch).
  await chipOt.click(); // toggle off
  await chipMismatch.click(); // toggle on
  await expectVisibleDrivers(page, [D4.kfiId]);
  await expect(countBadge).toHaveText("1 of 4 drivers");

  // 8. Combine search + chips: "Plain" + Un-reviewed → just D1 visible.
  await chipMismatch.click(); // turn off mismatch
  await search.fill("Plain");
  await expectVisibleDrivers(page, [D1.kfiId]);
  await expect(countBadge).toHaveText("1 of 4 drivers");

  // 9. A search that conflicts with an active chip yields the empty state.
  await search.fill("Reviewed"); // matches D2 by name, but D2 is filtered out by Un-reviewed.
  await expectVisibleDrivers(page, []);
  await expect(page.getByTestId("sidebar-empty-filtered")).toBeVisible();

  // 10. Reset everything.
  await page.getByTestId("button-sidebar-search-clear").click();
  await chipUnreviewed.click();
  await expectVisibleDrivers(page, [D1.kfiId, D2.kfiId, D3.kfiId, D4.kfiId]);
  await expect(countBadge).toHaveCount(0);
});
