/**
 * End-to-end coverage for the per-upload timezone override actually stamping
 * `punches.disp_tz` with the chosen zone.
 *
 * Surfaces touched:
 *   - Upload-tz picker in
 *     `artifacts/kfi-ot/src/components/customer-upload-panel.tsx` (the
 *     "Tz" select next to "Upload all customer files") and the `dispTz`
 *     multipart field it appends in `doUpload`.
 *   - `POST /weeks/:weekStart/upload-customer-file` route in
 *     `artifacts/api-server/src/routes/weeks.ts` which calls
 *     `resolveDispTz(kfiId, driverTz, overrideTz)` per row.
 *   - The new-customer confirm flow's `dispTz` body field — the dialog at
 *     `artifacts/kfi-ot/src/components/new-customer-dialog.tsx` posts it
 *     to `POST /weeks/:weekStart/confirm-new-customer`. The AI extract
 *     itself requires Gemini so (mirroring `new-customer-exclude.spec.ts`)
 *     we drive the confirm endpoint directly with a hand-crafted payload,
 *     which is the same contract the dialog uses.
 *
 * Without this, a regression in either route's tz plumbing (e.g. dropping
 * the multipart field, mis-naming the JSON key, or swallowing it before
 * `resolveDispTz`) could silently fall back to the driver / system default
 * and the unit test on `resolveDispTz` would not notice.
 *
 * The seeded driver has no `display_tz`, so the *default* resolution would
 * be `America/Chicago`. We pick `America/Denver` from the picker / confirm
 * payload and assert the persisted rows are stamped `America/Denver` — the
 * only way that's true is if the override travelled all the way through
 * the route.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the tz-override-upload e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-tzup-${Date.now().toString(36)}`;
const WEEK_START = "2031-07-06"; // Sunday
const WEEK_END = "2031-07-12"; // Saturday

// Penda parser coerces Employee Number via String(Math.round(Number(x))), so
// the kfiId has to be all digits. Use a high-prefix id well outside the real
// roster range. Second driver is for the new-customer confirm flow.
const DRIVER_PENDA = {
  kfiId: `91${Date.now()}`.slice(0, 10),
  name: "TZ Override Tester (Penda)",
  customer: "Penda",
};
const DRIVER_NEW = {
  kfiId: `92${Date.now()}`.slice(0, 10),
  name: "TZ Override Tester (New)",
  customer: "Penda",
};

const PENDA_FILE = `penda-${SUFFIX}.xlsx`;
const NEW_CUSTOMER = `ZZZ-TZ-NEW-${SUFFIX}`;
const NAME_ON_DOC = `Override, Tester ${SUFFIX}`;
const OVERRIDE_TZ = "America/Denver"; // non-default; driver row has no display_tz

function buildPendaXlsx(kfiId: string): Buffer {
  const rows = [
    ["Employee Number", "Date", "Time Start", "Time End", "Hours", "Pay Category"],
    [
      kfiId,
      `${WEEK_START} 00:00:00`,
      `${WEEK_START} 08:00:00`,
      `${WEEK_START} 12:00:00`,
      4,
      "Reg",
    ],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  for (const d of [DRIVER_PENDA, DRIVER_NEW]) {
    await pool.query(
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer,
             display_tz = NULL`,
      [d.kfiId, d.name, d.customer],
    );
  }
}

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = ANY($2::text[])`,
    [WEEK_START, [DRIVER_PENDA.kfiId, DRIVER_NEW.kfiId]],
  );
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE week_start = $1
         AND (customer = ANY($2::text[]) OR last_file_name LIKE $3)`,
    [WEEK_START, [DRIVER_PENDA.customer, NEW_CUSTOMER], `%${SUFFIX}%`],
  );
  await pool.query(
    `DELETE FROM customer_name_aliases WHERE customer = $1`,
    [NEW_CUSTOMER],
  );
  await pool.query(
    `DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`,
    [[DRIVER_PENDA.kfiId, DRIVER_NEW.kfiId]],
  );
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("per-upload tz override stamps punches.disp_tz on the legacy upload route", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto(`/weeks/${WEEK_START}`);
  await page.waitForLoadState("networkidle");

  // The bulk picker + tz select live in customer-upload-panel.tsx.
  await expect(
    page.getByRole("button", { name: /Upload all customer files/ }),
  ).toBeVisible();

  // Pick the non-default tz from the picker. The Select's trigger has a
  // stable data-testid; the listed options come from useGetAllowedTimezones.
  await page.getByTestId("select-upload-tz").click();
  await page.getByRole("option", { name: OVERRIDE_TZ }).click();
  await expect(page.getByTestId("select-upload-tz")).toContainText(
    OVERRIDE_TZ,
  );

  // Push a single valid Penda XLSX through the bulk picker — this goes
  // through doUpload(), which appends `dispTz` to the multipart form.
  const pendaBuf = buildPendaXlsx(DRIVER_PENDA.kfiId);
  const fileInput = page.locator(
    'input[type="file"][accept=".pdf,.xlsx,.xls"]',
  );
  await fileInput.setInputFiles([
    {
      name: PENDA_FILE,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: pendaBuf,
    },
  ]);

  // Wait for the bulk-results panel + the success row so we know the
  // upload settled before checking the DB.
  const resultsHeading = page.getByRole("heading", {
    name: "Bulk upload results",
  });
  await expect(resultsHeading).toBeVisible({ timeout: 30_000 });
  const bulkList = resultsHeading.locator("xpath=../../ul");
  const pendaRow = bulkList.locator("li", { hasText: PENDA_FILE });
  await expect(pendaRow).toContainText("1 punches imported");

  // Now the assertion that matters: every persisted row for our seeded
  // driver is stamped with the override tz, not the default Chicago.
  const rows = await pool.query<{ disp_tz: string }>(
    `SELECT disp_tz FROM punches
       WHERE week_start = $1 AND kfi_id = $2 AND source = 'Customer'`,
    [WEEK_START, DRIVER_PENDA.kfiId],
  );
  expect(rows.rowCount).toBe(1);
  expect(rows.rows.map((r) => r.disp_tz)).toEqual([OVERRIDE_TZ]);
});

test("dispTz on /confirm-new-customer stamps punches.disp_tz with the override", async ({
  page,
}) => {
  // Dev auth bypass so page.request carries a session cookie.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Three rows for the seeded NEW driver — same pattern as
  // new-customer-exclude.spec.ts. We post directly to /confirm-new-customer
  // because the AI extract preview requires Gemini; the dialog posts the
  // exact same shape (with `dispTz`) when the dispatcher clicks Confirm.
  const rows = [
    { driverNameOnDoc: NAME_ON_DOC, date: "2031-07-07", clockIn: "7:00 AM", clockOut: "3:00 PM", hours: 8 },
    { driverNameOnDoc: NAME_ON_DOC, date: "2031-07-08", clockIn: "7:00 AM", clockOut: "3:00 PM", hours: 8 },
  ];

  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-new-customer`,
    {
      data: {
        customer: NEW_CUSTOMER,
        mapping: { [NAME_ON_DOC]: DRIVER_NEW.kfiId },
        rows,
        excludedIndices: [],
        dispTz: OVERRIDE_TZ,
      },
    },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { imported: number };
  expect(body.imported).toBe(2);

  // Every imported row must carry the override tz. The seeded driver has
  // display_tz = NULL, so without the override the rows would land as
  // America/Chicago (the system default for non-IWG drivers).
  const persisted = await pool.query<{ disp_tz: string }>(
    `SELECT disp_tz FROM punches
       WHERE week_start = $1 AND customer = $2 AND kfi_id = $3
         AND source = 'Customer' AND is_manual = false
       ORDER BY date ASC`,
    [WEEK_START, NEW_CUSTOMER, DRIVER_NEW.kfiId],
  );
  expect(persisted.rowCount).toBe(2);
  expect(persisted.rows.map((r) => r.disp_tz)).toEqual([
    OVERRIDE_TZ,
    OVERRIDE_TZ,
  ]);

  // Negative control: a follow-up confirm WITHOUT dispTz must fall back to
  // the default (Chicago for this non-IWG driver) — proves the override
  // path is what flipped the stamp, not some unrelated default change.
  const res2 = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-new-customer`,
    {
      data: {
        customer: NEW_CUSTOMER,
        mapping: { [NAME_ON_DOC]: DRIVER_NEW.kfiId },
        rows,
        excludedIndices: [],
      },
    },
  );
  expect(res2.status()).toBe(200);
  const persisted2 = await pool.query<{ disp_tz: string }>(
    `SELECT disp_tz FROM punches
       WHERE week_start = $1 AND customer = $2 AND kfi_id = $3
         AND source = 'Customer' AND is_manual = false`,
    [WEEK_START, NEW_CUSTOMER, DRIVER_NEW.kfiId],
  );
  expect(persisted2.rows.map((r) => r.disp_tz)).toEqual([
    "America/Chicago",
    "America/Chicago",
  ]);
});
