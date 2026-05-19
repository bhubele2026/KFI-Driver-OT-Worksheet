/**
 * End-to-end coverage for the per-customer timezone preference
 * (`customer_tz_preferences`) actually winning over the driver default when
 * a customer file is ingested through both the legacy upload route *and*
 * the new-customer confirm flow.
 *
 * Surfaces touched:
 *   - `loadCustomerTzPrefMap()` in `artifacts/api-server/src/routes/weeks.ts`
 *     and its use inside the `/confirm-customer-file` and
 *     `/confirm-new-customer` handlers at lines ~1863 and ~2702 respectively.
 *   - The driver-detail `customerTzs` payload + `customer-files` panel —
 *     covered indirectly here via a `GET /weeks/:weekStart/drivers/:kfiId`
 *     assertion that confirms `customerTzs[*].preferredDispTz` reflects
 *     the saved pref.
 *   - The week summary's `hasCustomerTzMismatch` row flag — asserted via
 *     `GET /weeks/:weekStart/summary` after seeding an extra customer-source
 *     punch that disagrees with the driver's effective tz.
 *
 * Without this, a regression that drops the customer-pref lookup before
 * the `disp_tz` insert would silently fall back to `defaultDispTz(kfiId)`
 * (`America/Chicago` for a non-IWG driver) and the dispatcher's saved
 * preference would be quietly ignored every week.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the tz-customer-pref e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-tzpref-${Date.now().toString(36)}`;
const WEEK_START = "2031-08-03"; // Sunday
const WEEK_END = "2031-08-09"; // Saturday

const DRIVER_PENDA = {
  kfiId: `93${Date.now()}`.slice(0, 10),
  name: "TZ Pref Tester (Penda)",
  customer: "Penda",
};
const DRIVER_NEW = {
  kfiId: `94${Date.now()}`.slice(0, 10),
  name: "TZ Pref Tester (New)",
  customer: "Penda",
};

const PENDA_FILE = `penda-${SUFFIX}.xlsx`;
const NEW_CUSTOMER = `ZZZ-TZ-PREF-${SUFFIX}`;
const NAME_ON_DOC = `Pref, Tester ${SUFFIX}`;
const PREF_TZ_PENDA = "America/Denver"; // customer-pref for Penda
const PREF_TZ_NEW = "America/Los_Angeles"; // customer-pref for the new customer

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
  // Persist a customer-level tz preference for each customer we'll touch.
  // The /confirm routes must honor these even when the dispatcher does NOT
  // pass an explicit `dispTz` override — that's the whole point of the row.
  await pool.query(
    `INSERT INTO customer_tz_preferences (customer, display_tz)
       VALUES ($1, $2), ($3, $4)
     ON CONFLICT ((lower(customer))) DO UPDATE
       SET display_tz = EXCLUDED.display_tz`,
    ["Penda", PREF_TZ_PENDA, NEW_CUSTOMER, PREF_TZ_NEW],
  );
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
    `DELETE FROM customer_name_aliases WHERE customer = ANY($1::text[])`,
    [[NEW_CUSTOMER]],
  );
  // Only delete the Penda pref if it didn't exist before — but the upsert in
  // seed() means the previous value (if any) is gone anyway. Restore by
  // simply removing only what we added; this is an e2e DB so a missing
  // Penda pref row is acceptable post-test.
  await pool.query(
    `DELETE FROM customer_tz_preferences WHERE lower(customer) = ANY($1::text[])`,
    [["penda", NEW_CUSTOMER.toLowerCase()]],
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

test("customer tz preference is honored by /confirm-customer-file (no override)", async ({
  page,
}) => {
  // Seat the dev-bypass session cookie. We hit the API directly with the
  // same two-step (extract → confirm) shape the bulk-upload UI posts so
  // this spec is resilient to incidental UI changes; the contract being
  // tested is the server route's `disp_tz` stamping behavior.
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const pendaBuf = buildPendaXlsx(DRIVER_PENDA.kfiId);
  // Deliberately NOT sending `dispTz` on either request — the only path
  // that can stamp the row with Denver is the customer-pref lookup.
  const extractRes = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file`,
    { multipart: { file: { name: PENDA_FILE, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: pendaBuf } } },
  );
  expect(extractRes.status()).toBe(200);
  const extractBody = (await extractRes.json()) as {
    customer: string;
    sampleId: number;
  };
  expect(extractBody.customer).toBe("Penda");

  const confirmRes = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-customer-file`,
    {
      data: {
        customer: extractBody.customer,
        sampleId: extractBody.sampleId,
        // intentionally no `dispTz`
      },
    },
  );
  expect(confirmRes.status()).toBe(200);

  // The customer preference must have taken precedence over the driver's
  // default (Chicago) — without the new precedence tier the row would be
  // stamped America/Chicago.
  const rows = await pool.query<{ disp_tz: string }>(
    `SELECT disp_tz FROM punches
       WHERE week_start = $1 AND kfi_id = $2 AND source = 'Customer'`,
    [WEEK_START, DRIVER_PENDA.kfiId],
  );
  expect(rows.rowCount).toBe(1);
  expect(rows.rows.map((r) => r.disp_tz)).toEqual([PREF_TZ_PENDA]);

  // And the driver-detail payload must surface that customer's preference
  // as `preferredDispTz` so the new amber badge can render correctly.
  const detail = await page.request.get(
    `/api/weeks/${WEEK_START}/drivers/${DRIVER_PENDA.kfiId}`,
  );
  expect(detail.status()).toBe(200);
  const detailBody = (await detail.json()) as {
    customerTzs: Array<{
      customer: string;
      dispTz: string;
      matchesDriver: boolean;
      preferredDispTz: string | null;
    }>;
  };
  const pendaRowTz = detailBody.customerTzs.find(
    (r) => r.customer.toLowerCase() === "penda",
  );
  expect(pendaRowTz).toBeDefined();
  expect(pendaRowTz!.dispTz).toBe(PREF_TZ_PENDA);
  expect(pendaRowTz!.preferredDispTz).toBe(PREF_TZ_PENDA);
  // Driver effective is Chicago, customer pref is Denver → must mismatch.
  expect(pendaRowTz!.matchesDriver).toBe(false);

  // And the week-summary row must light up `hasCustomerTzMismatch`.
  const summary = await page.request.get(
    `/api/weeks/${WEEK_START}/summary`,
  );
  expect(summary.status()).toBe(200);
  const summaryBody = (await summary.json()) as {
    rows: Array<{ kfiId: string; hasCustomerTzMismatch: boolean }>;
  };
  const summaryRow = summaryBody.rows.find(
    (r) => r.kfiId === DRIVER_PENDA.kfiId,
  );
  expect(summaryRow).toBeDefined();
  expect(summaryRow!.hasCustomerTzMismatch).toBe(true);
});

test("customer tz preference is honored by /confirm-new-customer (no override)", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Confirm-new-customer is reachable directly with a hand-crafted payload
  // (the dialog posts the same shape). No `dispTz` field → the only path
  // that can stamp the rows with Los_Angeles is the new
  // `customerTzPref` lookup added in this task.
  const rows = [
    {
      driverNameOnDoc: NAME_ON_DOC,
      date: "2031-08-04",
      clockIn: "7:00 AM",
      clockOut: "3:00 PM",
      hours: 8,
    },
    {
      driverNameOnDoc: NAME_ON_DOC,
      date: "2031-08-05",
      clockIn: "7:00 AM",
      clockOut: "3:00 PM",
      hours: 8,
    },
  ];
  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-new-customer`,
    {
      data: {
        customer: NEW_CUSTOMER,
        mapping: { [NAME_ON_DOC]: DRIVER_NEW.kfiId },
        rows,
        excludedIndices: [],
        // intentionally no `dispTz`
      },
    },
  );
  expect(res.status()).toBe(200);

  const persisted = await pool.query<{ disp_tz: string }>(
    `SELECT disp_tz FROM punches
       WHERE week_start = $1 AND customer = $2 AND kfi_id = $3
         AND source = 'Customer' AND is_manual = false
       ORDER BY date ASC`,
    [WEEK_START, NEW_CUSTOMER, DRIVER_NEW.kfiId],
  );
  expect(persisted.rowCount).toBe(2);
  expect(persisted.rows.map((r) => r.disp_tz)).toEqual([
    PREF_TZ_NEW,
    PREF_TZ_NEW,
  ]);

  // Negative control: an explicit dispTz override beats the customer pref.
  // Wipe and retry with an override to prove the precedence order
  // (override > customer-pref > driver-default) is intact.
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, NEW_CUSTOMER],
  );
  const res2 = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-new-customer`,
    {
      data: {
        customer: NEW_CUSTOMER,
        mapping: { [NAME_ON_DOC]: DRIVER_NEW.kfiId },
        rows,
        excludedIndices: [],
        dispTz: "America/Phoenix",
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
    "America/Phoenix",
    "America/Phoenix",
  ]);
});

test("shift-punches with customer filter only moves that customer's rows", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Seed two Customer-source punches for the same driver, two different
  // customers, both currently in Chicago. The new `customer` filter on
  // shift-punches must move exactly one row.
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER_PENDA.kfiId],
  );
  await pool.query(
    `INSERT INTO punches
        (week_start, kfi_id, customer, source, date, clock_in, clock_out,
         hours, disp_tz, is_manual)
       VALUES
        ($1, $2, 'Penda',  'Customer', $3, $4, $5, 4, 'America/Chicago', true),
        ($1, $2, 'Adient', 'Customer', $3, $4, $5, 4, 'America/Chicago', true)`,
    [
      WEEK_START,
      DRIVER_PENDA.kfiId,
      WEEK_START,
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 12:00 PM`,
    ],
  );

  const shift = await page.request.post(
    `/api/weeks/${WEEK_START}/drivers/${DRIVER_PENDA.kfiId}/shift-punches`,
    {
      data: {
        offsetHours: 2,
        source: "Customer",
        customer: "Penda",
        newDispTz: "America/Denver",
      },
    },
  );
  expect(shift.status()).toBe(200);
  const shiftBody = (await shift.json()) as { shifted: number };
  expect(shiftBody.shifted).toBe(1);

  const after = await pool.query<{ customer: string; clock_in: string; disp_tz: string }>(
    `SELECT customer, clock_in, disp_tz FROM punches
       WHERE week_start = $1 AND kfi_id = $2 ORDER BY customer ASC`,
    [WEEK_START, DRIVER_PENDA.kfiId],
  );
  const adient = after.rows.find((r) => r.customer === "Adient")!;
  const penda = after.rows.find((r) => r.customer === "Penda")!;
  // Adient row was scoped out — unchanged.
  expect(adient.clock_in).toContain("8:00 AM");
  expect(adient.disp_tz).toBe("America/Chicago");
  // Penda row was shifted +2h and restamped.
  expect(penda.clock_in).toContain("10:00 AM");
  expect(penda.disp_tz).toBe("America/Denver");
});
