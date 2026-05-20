/**
 * End-to-end coverage for the per-punch "needs review" red flag button.
 *
 *  1. From the driver-detail page, click the per-punch flag button — the row
 *     gains the rose tint marker (`data-flagged="true"`) and the header
 *     surfaces a "1 flagged" pill.
 *  2. A page reload preserves the flagged state (it is persisted server-side
 *     and re-hydrated via GET /driver-week).
 *  3. The sidebar (week-summary driver list) shows a compact red flag count
 *     badge next to the flagged driver's reviewed bubble.
 *  4. Mutual exclusion: marking the same punch reviewed clears the flag.
 *  5. Re-flagging then unflagging via the same button removes the row tint
 *     and the header pill.
 *
 * Seeds an isolated week + driver with one Driver-source punch via direct
 * DB writes, and cleans up afterwards. The driver name is alphabetically
 * first inside the seeded customer bucket so the sidebar lookup is stable
 * even if other test-residue drivers happen to share the customer.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const WEEK_START = "2031-05-04";
const WEEK_END = "2031-05-10";
const SUFFIX = `e2e-pf-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-PF-${SUFFIX}`,
  name: `AAA Flag Driver ${SUFFIX}`,
  customer: "Adient",
} as const;

let punchId = 0;

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
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO punches
         (week_start, kfi_id, customer, source, date,
          clock_in, clock_out, hours, is_manual)
       VALUES ($1::date, $2, $3, 'Driver', $4,
               $5, $6, 4.0, true)
       RETURNING id`,
      [
        WEEK_START,
        DRIVER.kfiId,
        DRIVER.customer,
        WEEK_START,
        `${WEEK_START} 8:00 AM`,
        `${WEEK_START} 12:00 PM`,
      ],
    );
    punchId = rows[0].id;
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

test("per-punch red flag persists, surfaces in header + sidebar, and is mutually exclusive with reviewed", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`);
  await expect(
    page.getByRole("heading", { name: DRIVER.name }),
  ).toBeVisible();

  const row = page.getByTestId(`row-punch-${punchId}`);
  const flagBtn = page.getByTestId(`button-punch-flag-${punchId}`);
  const reviewedCb = page.getByTestId(`checkbox-punch-reviewed-${punchId}`);
  const headerFlagPill = page.getByTestId("pill-punch-flagged-count");
  const sidebarFlagBadge = page.getByTestId(
    `sidebar-flag-count-${DRIVER.kfiId}`,
  );

  // Baseline: nothing flagged.
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute("data-flagged", "true");
  await expect(flagBtn).toHaveAttribute("aria-pressed", "false");
  await expect(headerFlagPill).toHaveCount(0);
  await expect(sidebarFlagBadge).toHaveCount(0);

  // 1. Click the flag button → row tints, header pill appears, sidebar badge appears.
  await flagBtn.click();
  await expect(row).toHaveAttribute("data-flagged", "true");
  await expect(flagBtn).toHaveAttribute("aria-pressed", "true");
  await expect(headerFlagPill).toHaveText(/1 flagged/);
  await expect(sidebarFlagBadge).toBeVisible();
  await expect(sidebarFlagBadge).toContainText("1");

  // 2. Reload the page — the flag survives.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: DRIVER.name }),
  ).toBeVisible();
  await expect(page.getByTestId(`row-punch-${punchId}`)).toHaveAttribute(
    "data-flagged",
    "true",
  );
  await expect(page.getByTestId("pill-punch-flagged-count")).toHaveText(
    /1 flagged/,
  );

  // 3. Mutual exclusion: tick the reviewed checkbox → flag clears.
  await page.getByTestId(`checkbox-punch-reviewed-${punchId}`).click();
  await expect(
    page.getByTestId(`checkbox-punch-reviewed-${punchId}`),
  ).toHaveAttribute("data-state", "checked");
  await expect(page.getByTestId(`row-punch-${punchId}`)).not.toHaveAttribute(
    "data-flagged",
    "true",
  );
  await expect(page.getByTestId("pill-punch-flagged-count")).toHaveCount(0);
  await expect(
    page.getByTestId(`sidebar-flag-count-${DRIVER.kfiId}`),
  ).toHaveCount(0);

  // 4. Re-flagging clears the reviewed state in turn.
  await page.getByTestId(`button-punch-flag-${punchId}`).click();
  await expect(
    page.getByTestId(`checkbox-punch-reviewed-${punchId}`),
  ).toHaveAttribute("data-state", "unchecked");
  await expect(page.getByTestId(`row-punch-${punchId}`)).toHaveAttribute(
    "data-flagged",
    "true",
  );

  // 5. Toggling the flag off restores the baseline.
  await page.getByTestId(`button-punch-flag-${punchId}`).click();
  await expect(page.getByTestId(`row-punch-${punchId}`)).not.toHaveAttribute(
    "data-flagged",
    "true",
  );
  await expect(page.getByTestId("pill-punch-flagged-count")).toHaveCount(0);

  // Silence unused-helper lint — reviewedCb / row references are kept above
  // so a future regression that breaks the locators surfaces immediately
  // instead of dying with a cryptic "element not found".
  void reviewedCb;
  void row;
});
