/**
 * End-to-end coverage for adding, editing, and deleting a manual punch on
 * the per-driver page (artifacts/kfi-ot/src/pages/driver-detail.tsx) and
 * watching totals + validation alerts react.
 *
 * Verifies:
 *   - Empty state shows "No punches recorded for this week." and totals
 *     start at 0.00.
 *   - The Add Punch dialog creates a Driver-source punch; the row shows up,
 *     the Total Driver / Total summary rows update, and no alerts appear.
 *   - Inline edit changes the clock-out and the row's hours + the Total
 *     Driver row update.
 *   - Adding a second overlapping Driver-source punch surfaces the
 *     "Validation Alerts" card (the hours engine flags same-source overlap
 *     >10 minutes).
 *   - Deleting one of the overlapping punches clears the alerts card and
 *     totals fall back to a single-punch value.
 *
 * Seeds an isolated week + driver via direct DB writes; no pre-existing
 * punches. Native confirm dialogs (delete) are auto-accepted.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const WEEK_START = "2031-04-13";
const WEEK_END = "2031-04-19";
const SUFFIX = `e2e-mp-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-MP-${SUFFIX}`,
  name: "Manual Punch Tester",
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

test("dispatcher can add, edit, and delete manual punches with totals + alerts updating", async ({
  page,
}) => {
  // Auto-accept the native window.confirm fired by the delete button.
  page.on("dialog", (d) => {
    void d.accept();
  });

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`);
  await expect(page.getByRole("heading", { name: DRIVER.name })).toBeVisible();

  const totalDriverRow = page.getByTestId("row-summary-total-driver");
  const validationAlerts = page.getByText("Validation Alerts");

  // 1. Baseline empty state.
  await expect(
    page.getByText("No punches recorded for this week."),
  ).toBeVisible();
  await expect(totalDriverRow).toContainText("0.00");
  await expect(validationAlerts).toHaveCount(0);

  // 2. Add a manual Driver-source punch via the dialog: 8:00 AM – 12:00 PM.
  await page.getByRole("button", { name: "Add Punch" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Manual Punch" });
  await expect(dialog).toBeVisible();
  // Date input defaults to weekStart already; keep as-is. The Clock In /
  // Clock Out fields use shadcn <Label> blocks not wired up via htmlFor,
  // so target by placeholder ("7:30 AM" / "3:45 PM") instead.
  await dialog.locator('input[type="date"]').fill(WEEK_START);
  await dialog.getByPlaceholder("7:30 AM").fill("8:00 AM");
  await dialog.getByPlaceholder("3:45 PM").fill("12:00 PM");
  await dialog.getByRole("button", { name: "Save Punch" }).click();
  await expect(dialog).not.toBeVisible();

  // Row appears with hours 4.00; Total Driver bumps to 4.00.
  await expect(page.getByText("No punches recorded for this week.")).toHaveCount(0);
  await expect(totalDriverRow).toContainText("4.00");
  await expect(validationAlerts).toHaveCount(0);

  // 3. Inline edit: extend clock-out from 12:00 PM to 1:00 PM (5h total).
  //    The punch row id is needed for the edit/save testids; pull it from
  //    the freshly-created punch in the DB so the test stays stable.
  const firstId = await pool
    .query<{ id: number }>(
      `SELECT id FROM punches WHERE week_start = $1 AND kfi_id = $2
         ORDER BY id ASC LIMIT 1`,
      [WEEK_START, DRIVER.kfiId],
    )
    .then((r) => r.rows[0].id);

  await page.getByTestId(`button-edit-punch-${firstId}`).click();
  // Two text inputs appear in the edited row: clock-in then clock-out.
  const editingRow = page
    .getByTestId(`button-save-punch-${firstId}`)
    .locator("xpath=ancestor::tr");
  // The shadcn <Input> renders a bare <input> with no explicit type, so a
  // `[type="text"]` selector misses it. Two inputs appear in this row:
  // clock-in then clock-out — fill the second one.
  const editInputs = editingRow.locator("input");
  await editInputs.nth(1).fill(`${WEEK_START} 1:00 PM`);
  await page.getByTestId(`button-save-punch-${firstId}`).click();
  await expect(page.getByTestId(`button-save-punch-${firstId}`)).toHaveCount(0);
  await expect(totalDriverRow).toContainText("5.00");

  // 4. Add a second overlapping Driver-source punch to trigger the
  //    same-source overlap alert (>10 min): 9:00 AM – 11:00 AM overlaps
  //    the first punch by ~120 min.
  await page.getByRole("button", { name: "Add Punch" }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="date"]').fill(WEEK_START);
  await dialog.getByPlaceholder("7:30 AM").fill("9:00 AM");
  await dialog.getByPlaceholder("3:45 PM").fill("11:00 AM");
  await dialog.getByRole("button", { name: "Save Punch" }).click();
  await expect(dialog).not.toBeVisible();

  await expect(validationAlerts).toBeVisible();
  await expect(page.getByText(/punches overlap by/i)).toBeVisible();

  // 5. Delete the second (overlapping) punch. Alerts disappear, totals
  //    fall back to the first (5h) punch.
  const secondId = await pool
    .query<{ id: number }>(
      `SELECT id FROM punches WHERE week_start = $1 AND kfi_id = $2
         ORDER BY id DESC LIMIT 1`,
      [WEEK_START, DRIVER.kfiId],
    )
    .then((r) => r.rows[0].id);

  await page.getByTestId(`button-delete-punch-${secondId}`).click();
  await expect(page.getByTestId(`button-delete-punch-${secondId}`)).toHaveCount(0);
  await expect(validationAlerts).toHaveCount(0);
  await expect(totalDriverRow).toContainText("5.00");

  // 6. Delete the remaining punch — back to the empty state.
  await page.getByTestId(`button-delete-punch-${firstId}`).click();
  await expect(
    page.getByText("No punches recorded for this week."),
  ).toBeVisible();
  await expect(totalDriverRow).toContainText("0.00");
});
