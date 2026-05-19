/**
 * End-to-end coverage for task #247: punch wall-clock times are always
 * rendered in 12-hour `h:MM AM/PM` shape on the driver-detail page,
 * even for legacy rows the DB still holds in 24-hour `HH:MM[:SS]`
 * form.
 *
 * Seeds three punches:
 *   1. Modern canonical:        `2031-05-11 8:15 AM`
 *   2. Legacy 24-hour:          `2031-05-11 13:28:00`
 *   3. Legacy 24-hour midnight: `2031-05-12 00:05`
 *
 * Then asserts the rendered cells read "8:15 AM", "1:28 PM",
 * "12:05 AM" — never the raw 24-hour string. Catches a regression to
 * the bare-string render that surfaced `13:28:00` to dispatchers.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the punch-12-hour-display e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-05-11";
const WEEK_END = "2031-05-17";
const SUFFIX = `e2e-12h-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-12H-${SUFFIX}`,
  name: "AAA Twelve Hour",
  customer: "Adient",
};

type SeededPunch = { id: number };

async function seed(): Promise<SeededPunch[]> {
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
    const rows: SeededPunch[] = [];
    // Mix of canonical 12-hour and legacy 24-hour wall-clock strings —
    // the frontend must tolerate both with no backfill.
    const punchSpecs = [
      { date: "2031-05-11", ci: "8:15 AM", co: "12:00 PM", h: 3.75 },
      { date: "2031-05-11", ci: "13:28:00", co: "17:00:00", h: 3.53 },
      { date: "2031-05-12", ci: "00:05", co: "04:05", h: 4.0 },
    ];
    for (const s of punchSpecs) {
      const r = await client.query(
        `INSERT INTO punches
           (week_start, kfi_id, customer, source, date,
            clock_in, clock_out, hours, is_manual)
         VALUES ($1::date, $2, $3, 'Driver', $4,
                 $5, $6, $7, true)
         RETURNING id`,
        [
          WEEK_START,
          DRIVER.kfiId,
          DRIVER.customer,
          s.date,
          `${s.date} ${s.ci}`,
          `${s.date} ${s.co}`,
          s.h,
        ],
      );
      rows.push({ id: r.rows[0].id });
    }
    await client.query("COMMIT");
    return rows;
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

let seededPunches: SeededPunch[] = [];

test.beforeAll(async () => {
  await cleanup();
  seededPunches = await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("driver-detail renders both canonical 12-hour and legacy 24-hour punches as h:MM AM/PM", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  // Set up the response wait BEFORE navigating so we don't race past it.
  const detailFetched = page.waitForResponse(
    (r) =>
      r.url().includes(
        `/api/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`,
      ) && r.status() === 200,
    { timeout: 30_000 },
  );
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`);
  await detailFetched;
  await expect(
    page.getByRole("heading", { name: DRIVER.name }),
  ).toBeVisible({ timeout: 20_000 });

  // Clock In / Clock Out are the 3rd and 4th <td> in a punch row (cols:
  // date, source/flags, clock-in, clock-out, …). Wrap them with a small
  // helper keyed off the row testid.
  const clockIn = (id: number) =>
    page.getByTestId(`row-punch-${id}`).locator("td").nth(2);
  const clockOut = (id: number) =>
    page.getByTestId(`row-punch-${id}`).locator("td").nth(3);

  const [first, second, third] = seededPunches;

  // driver-detail's clock cell renders `h:MM AM/PM`, optionally prefixed
  // with `MM/DD, ` when the punch's wall-clock date differs from the row's
  // grouped date (cross-midnight / out-of-row date). Match on the
  // trailing 12-hour token so both shapes pass.
  const endsWith12h = (s: string) =>
    new RegExp(`(^|, )${s.replace(/ /g, "\\s")}$`);

  // Punch 1: already canonical — should stay canonical.
  await expect(clockIn(first.id)).toHaveText(endsWith12h("8:15 AM"));
  await expect(clockOut(first.id)).toHaveText(endsWith12h("12:00 PM"));

  // Punch 2: legacy `13:28:00` / `17:00:00` must render as 1:28 PM / 5:00 PM
  // — NOT `13:28:00`, which is what a naive bare-string render produced.
  await expect(clockIn(second.id)).toHaveText(endsWith12h("1:28 PM"));
  await expect(clockOut(second.id)).toHaveText(endsWith12h("5:00 PM"));

  // Punch 3: legacy midnight without seconds. `00:05` → 12:05 AM.
  await expect(clockIn(third.id)).toHaveText(endsWith12h("12:05 AM"));
  await expect(clockOut(third.id)).toHaveText(endsWith12h("4:05 AM"));

  // Belt-and-suspenders: no 24-hour shape should be visible anywhere in
  // the seeded punch rows (e.g. `13:28` or `17:00:00`).
  for (const id of [first.id, second.id, third.id]) {
    const row = page.getByTestId(`row-punch-${id}`);
    for (const banned of ["13:28", "17:00", "00:05", "04:05"]) {
      await expect(row).not.toContainText(banned);
    }
  }
});

/**
 * Second coverage: drive an actual customer-file fixture through the
 * full ingest pipeline (the real two-step
 * `extract-customer-file` + `confirm-customer-file` route the bulk
 * uploader uses) and assert every Customer-source punch the parser
 * wrote lands in DB in the canonical `YYYY-MM-DD h:MM AM/PM` shape.
 * This pins the contract from "raw Excel cell" → "Postgres row"
 * without going through the UI, so a parser regression that drops the
 * AM/PM marker (or sneaks in trailing seconds) trips this test even
 * if the frontend tolerates legacy shape.
 */
const UPLOAD_WEEK_START = "2031-05-04"; // Sunday
const UPLOAD_WEEK_END = "2031-05-10"; // Saturday
const UPLOAD_SUFFIX = `e2e-12h-up-${Date.now().toString(36)}`;
// Penda parser coerces the Employee Number through `String(Math.round(...))`,
// so the seeded driver id must be digits-only. Use a high prefix to stay
// well outside the real KFI roster range.
const UPLOAD_DRIVER = {
  kfiId: `8${Date.now()}`,
  name: "Twelve Hour Upload Tester",
  customer: "Penda",
};
const PENDA_UPLOAD_FILE = `penda-${UPLOAD_SUFFIX}.xlsx`;

// Build a Penda-shaped xlsx with rows whose Time Start / Time End columns
// are raw 24-hour `HH:MM:SS` strings. The parser writes through `fmtDT`,
// which must convert them to `h:MM AM/PM` before persisting. If a future
// edit drops that normalization, the DB row will read `13:28:00` and
// this test will fail.
function buildPenda24HourXlsx(kfiId: string): Buffer {
  const rows = [
    [
      "Employee Number",
      "Date",
      "Time Start",
      "Time End",
      "Hours",
      "Pay Category",
    ],
    // Afternoon shift crossing noon — exercises the 13:00+ → PM branch.
    [
      kfiId,
      `${UPLOAD_WEEK_START} 00:00:00`,
      `${UPLOAD_WEEK_START} 13:28:00`,
      `${UPLOAD_WEEK_START} 17:00:00`,
      3.53,
      "Reg",
    ],
    // Morning shift — exercises the AM branch and single-digit hour.
    [
      kfiId,
      `2031-05-05 00:00:00`,
      `2031-05-05 08:15:00`,
      `2031-05-05 12:00:00`,
      3.75,
      "Reg",
    ],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function cleanupUploadWeek(): Promise<void> {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [UPLOAD_WEEK_START, UPLOAD_DRIVER.kfiId],
  );
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE week_start = $1
         AND (last_file_name LIKE $2 OR customer = $3)`,
    [UPLOAD_WEEK_START, `%${UPLOAD_SUFFIX}%`, UPLOAD_DRIVER.customer],
  );
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [
    UPLOAD_WEEK_START,
  ]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [
    UPLOAD_DRIVER.kfiId,
  ]);
}

test.describe("real customer-file upload writes 12-hour clocks", () => {
  test.beforeAll(async () => {
    await cleanupUploadWeek();
    await pool.query(
      `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
       ON CONFLICT (start_date) DO NOTHING`,
      [UPLOAD_WEEK_START, UPLOAD_WEEK_END],
    );
    await pool.query(
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
      [UPLOAD_DRIVER.kfiId, UPLOAD_DRIVER.name, UPLOAD_DRIVER.customer],
    );
  });

  test.afterAll(async () => {
    await cleanupUploadWeek();
  });

  test("uploaded Penda punches with 24-hour times persist as h:MM AM/PM", async ({
    page,
  }) => {
    await signInAsDispatcher(page);

    const buffer = buildPenda24HourXlsx(UPLOAD_DRIVER.kfiId);
    // Step 1: extract-customer-file — multipart preview that stashes the
    // bytes and returns a sampleId.
    const extractRes = await page.request.post(
      `/api/weeks/${UPLOAD_WEEK_START}/extract-customer-file`,
      {
        multipart: {
          file: {
            name: PENDA_UPLOAD_FILE,
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer,
          },
        },
      },
    );
    expect(
      extractRes.status(),
      `extract failed: ${await extractRes.text()}`,
    ).toBe(200);
    const extracted = (await extractRes.json()) as {
      customer: string;
      sampleId: number;
      rows: Array<{ index: number }>;
    };
    expect(extracted.customer).toBe(UPLOAD_DRIVER.customer);
    expect(extracted.sampleId).toEqual(expect.any(Number));
    expect(extracted.rows.length).toBe(2);

    // Step 2: confirm-customer-file — JSON commit, persists every row that
    // wasn't excluded.
    const confirmRes = await page.request.post(
      `/api/weeks/${UPLOAD_WEEK_START}/confirm-customer-file`,
      {
        data: {
          customer: extracted.customer,
          sampleId: extracted.sampleId,
          excludedIndices: [],
        },
      },
    );
    expect(
      confirmRes.status(),
      `confirm failed: ${await confirmRes.text()}`,
    ).toBe(200);

    const rows = await pool.query<{ clock_in: string; clock_out: string }>(
      `SELECT clock_in, clock_out FROM punches
         WHERE week_start = $1::date AND kfi_id = $2 AND source = 'Customer'
         ORDER BY date`,
      [UPLOAD_WEEK_START, UPLOAD_DRIVER.kfiId],
    );
    expect(rows.rowCount ?? 0).toBe(2);
    const wallClock12 = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} (AM|PM)$/;
    for (const r of rows.rows) {
      expect(r.clock_in, "clock_in shape").toMatch(wallClock12);
      expect(r.clock_out, "clock_out shape").toMatch(wallClock12);
      const hourIn = r.clock_in.split(" ")[1].split(":")[0];
      const hourOut = r.clock_out.split(" ")[1].split(":")[0];
      expect(hourIn.startsWith("0")).toBe(false);
      expect(hourOut.startsWith("0")).toBe(false);
    }
    // Pin the exact converted shape for the 13:28 / 17:00 row — proves
    // the AM/PM conversion isn't just stripping seconds.
    expect(rows.rows[0].clock_in).toBe(`${UPLOAD_WEEK_START} 1:28 PM`);
    expect(rows.rows[0].clock_out).toBe(`${UPLOAD_WEEK_START} 5:00 PM`);
    expect(rows.rows[1].clock_in).toBe("2031-05-05 8:15 AM");
    expect(rows.rows[1].clock_out).toBe("2031-05-05 12:00 PM");
  });
});
