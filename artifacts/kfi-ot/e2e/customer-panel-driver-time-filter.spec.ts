/**
 * End-to-end coverage for filtering the customer-files panel to only
 * customers with active driver time for the selected week.
 *
 * Surfaces touched:
 *   - `GET /weeks/:weekStart/customer-uploads` in
 *     `artifacts/api-server/src/routes/weeks.ts`.
 *
 * Seeds two roster drivers for the same week:
 *   - DRV_WITH_TIME assigned to a unique customer "WithTime …" and given a
 *     Driver-source punch for the week. That customer must appear in the
 *     panel response.
 *   - DRV_NO_TIME assigned to a unique customer "NoTime …" with no
 *     punches at all. That customer must NOT appear — this is the
 *     "zzKFI Internal / zzzTest" case from the screenshot.
 *
 * Also seeds a third "PriorUpload …" customer with a `customer_upload_attempts`
 * row but zero driver-source punches, and confirms it stays visible so
 * prior dispatcher work is never hidden.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const WEEK_START = "2031-06-08";
const WEEK_END = "2031-06-14";
const SUFFIX = `e2e-cpdt-${Date.now().toString(36)}`;

const CUST_WITH_TIME = `WithTime-${SUFFIX}`;
const CUST_NO_TIME = `NoTime-${SUFFIX}`;
const CUST_PRIOR_UPLOAD = `PriorUpload-${SUFFIX}`;

const DRV_WITH_TIME = `KFI-CPDT-A-${SUFFIX}`;
const DRV_NO_TIME = `KFI-CPDT-B-${SUFFIX}`;

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1::date, $2::date)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO UPDATE
       SET name = EXCLUDED.name, customer = EXCLUDED.customer,
           is_archived = false`,
    [DRV_WITH_TIME, `${SUFFIX} With-Time Driver`, CUST_WITH_TIME],
  );
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO UPDATE
       SET name = EXCLUDED.name, customer = EXCLUDED.customer,
           is_archived = false`,
    [DRV_NO_TIME, `${SUFFIX} No-Time Driver`, CUST_NO_TIME],
  );
  // Driver-source punch for the with-time driver. customer=null on the
  // punch row matches what Connecteam ingest writes; the route derives
  // the customer from drivers.kfi_id.
  await pool.query(
    `INSERT INTO punches
       (week_start, kfi_id, customer, source, date,
        clock_in, clock_out, hours, is_manual)
     VALUES ($1::date, $2, NULL, 'Driver', $1::date,
             $3, $4, 4.0, false)`,
    [
      WEEK_START,
      DRV_WITH_TIME,
      `${WEEK_START} 8:00 AM`,
      `${WEEK_START} 12:00 PM`,
    ],
  );
  // Prior upload attempt for a customer with no driver time this week.
  await pool.query(
    `INSERT INTO customer_upload_attempts
       (week_start, customer, last_attempt_at, last_success_at,
        last_file_name, last_error, last_source, last_unmapped_ids)
     VALUES ($1::date, $2, NOW(), NOW(),
             $3, NULL, 'ai', '[]'::jsonb)
     ON CONFLICT (week_start, customer) DO UPDATE
       SET last_attempt_at = EXCLUDED.last_attempt_at`,
    [WEEK_START, CUST_PRIOR_UPLOAD, `${CUST_PRIOR_UPLOAD}.pdf`],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE customer = ANY($1::text[])`,
    [[CUST_WITH_TIME, CUST_NO_TIME, CUST_PRIOR_UPLOAD]],
  );
  await pool.query(`DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`, [
    [DRV_WITH_TIME, DRV_NO_TIME],
  ]);
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

test("customer-files panel hides roster customers with no driver time and keeps customers with prior uploads", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  const res = await page.request.get(
    `/api/weeks/${WEEK_START}/customer-uploads`,
  );
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as Array<{ customer: string }>;
  const names = new Set(body.map((r) => r.customer));

  // Roster customer with at least one Driver-source punch for the week
  // appears in the panel response.
  expect(names.has(CUST_WITH_TIME)).toBe(true);
  // Roster customer with no driver time this week is filtered out.
  // This is the "zzKFI Internal / zzzTest" case.
  expect(names.has(CUST_NO_TIME)).toBe(false);
  // Customer with a recorded upload attempt stays visible even though
  // no driver has time against it this week — prior dispatcher work
  // must never be hidden.
  expect(names.has(CUST_PRIOR_UPLOAD)).toBe(true);
});
