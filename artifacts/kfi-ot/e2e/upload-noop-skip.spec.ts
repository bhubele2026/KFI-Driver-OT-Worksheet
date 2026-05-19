/**
 * End-to-end coverage for the SHA-256-based no-op skip on the
 * `/api/weeks/:weekStart/upload-customer-file` route.
 *
 * Locks in the behavior introduced in task #141:
 *   - First upload of a file parses and writes punches.
 *   - Re-uploading the exact same bytes for the same (week, customer)
 *     short-circuits server-side and returns `{ skipped: true,
 *     punchesUpserted: 0 }` without touching the punches table.
 *   - Passing `?force=1` bypasses the short-circuit and re-parses /
 *     re-inserts, even when the bytes are unchanged.
 *
 * Surfaces touched:
 *   - `artifacts/api-server/src/routes/weeks.ts` upload route
 *     (contentHash + force handling).
 *   - `lib/db/src/schema/customerUploadAttempts.ts` (`last_content_hash`
 *     persisted by `recordAttempt`).
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the upload-noop-skip e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-skip-${Date.now().toString(36)}`;
const WEEK_START = "2031-07-06"; // Sunday
const WEEK_END = "2031-07-12"; // Saturday
const DRIVER = {
  kfiId: `9${Date.now()}`,
  name: "Skip Flow Tester",
  customer: "Penda",
};
const PENDA_FILE = `penda-${SUFFIX}.xlsx`;

function buildPendaXlsx(kfiId: string): Buffer {
  // Matches the bulk-upload fixture shape: parsePendaTrienda needs these
  // headers and falls back to `kfiSet.has(empId)` when the id is unmapped.
  const rows = [
    [
      "Employee Number",
      "Date",
      "Time Start",
      "Time End",
      "Hours",
      "Pay Category",
    ],
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
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER.kfiId],
  );
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE week_start = $1
         AND (last_file_name LIKE $2 OR customer = $3)`,
    [WEEK_START, `%${SUFFIX}%`, DRIVER.customer],
  );
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [DRIVER.kfiId]);
}

async function countCustomerPunches(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM punches
       WHERE week_start = $1 AND kfi_id = $2 AND source = 'Customer'`,
    [WEEK_START, DRIVER.kfiId],
  );
  return Number(r.rows[0]?.n ?? "0");
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("re-uploading identical bytes short-circuits; ?force=1 bypasses", async ({
  page,
}) => {
  // Authenticate explicitly via the dev-bypass route so page.request
  // carries an admin session cookie. Calling it directly (instead of
  // relying on AuthGate to fire from page.goto) avoids the race where
  // the first multipart POST below lands before AuthGate's fetch sets
  // the cookie.
  const bypass = await page.request.post("/api/auth/dev-bypass");
  expect(bypass.status()).toBe(200);

  const buf = buildPendaXlsx(DRIVER.kfiId);
  const url = `/api/weeks/${WEEK_START}/upload-customer-file`;
  const multipart = {
    file: {
      name: PENDA_FILE,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buf,
    },
  };

  // 1. First upload: file is parsed, punches written.
  const first = await page.request.post(url, { multipart });
  expect(first.status()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.customer).toBe("Penda");
  expect(firstBody.skipped).toBeFalsy();
  expect(firstBody.punchesUpserted).toBeGreaterThan(0);
  expect(await countCustomerPunches()).toBe(firstBody.punchesUpserted);

  // 2. Second upload of the exact same bytes: server short-circuits on
  //    the SHA-256 hash, returns skipped=true with 0 upserted, and the
  //    DB row count is unchanged.
  const second = await page.request.post(url, { multipart });
  expect(second.status()).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.skipped).toBe(true);
  expect(secondBody.punchesUpserted).toBe(0);
  expect(secondBody.customer).toBe("Penda");
  expect(await countCustomerPunches()).toBe(firstBody.punchesUpserted);

  // 3. Re-upload with ?force=1: bypasses the short-circuit and parses
  //    again. The wipe-and-reinsert tx keeps the final row count equal
  //    to the first import's count (1 row in, 1 row replacing the old
  //    one), and the response is NOT marked skipped.
  const forced = await page.request.post(`${url}?force=1`, { multipart });
  expect(forced.status()).toBe(200);
  const forcedBody = await forced.json();
  expect(forcedBody.skipped).toBeFalsy();
  expect(forcedBody.punchesUpserted).toBe(firstBody.punchesUpserted);
  expect(await countCustomerPunches()).toBe(firstBody.punchesUpserted);
});
