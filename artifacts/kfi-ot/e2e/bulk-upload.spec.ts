/**
 * End-to-end coverage for the one-click bulk customer-file upload flow on
 * the week dashboard.
 *
 * Surfaces touched:
 *   - The "Upload all customer files" button + per-file progress list in
 *     `artifacts/kfi-ot/src/components/customer-upload-panel.tsx` and its
 *     client-side `classifyFile` routing (which reads the `keywords` /
 *     `extensions` returned by `GET /weeks/:weekStart/customer-uploads`).
 *   - The server-side keyword routing in
 *     `artifacts/api-server/src/lib/parsers/customers.ts` (KNOWN_CUSTOMERS)
 *     and the `/weeks/:weekStart/extract-customer-file` +
 *     `/confirm-customer-file` routes the bulk flow now drives.
 *
 * The test seeds an isolated week + driver and picks 4 files via the bulk
 * picker:
 *   1. A valid Penda XLSX whose only row references the seeded driver —
 *      should land as a success row with the imported punch count.
 *   2. A PDF whose filename matches no known-customer keyword — should be
 *      classified as "unknown" client-side and surface the
 *      "New customer file…" shortcut.
 *   3. A `.txt` file (bogus extension) — should also be classified as
 *      "unknown" with the shortcut button.
 *   4. A PDF whose filename matches the IWG keyword but whose bytes are
 *      not a valid PDF — should route to the IWG parser, fail server-side,
 *      and surface as a failed row.
 *
 * Finally we assert the summary toast text "1 uploaded, 2 need review, 1
 * failed.".
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the bulk-upload e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-bu-${Date.now().toString(36)}`;
const WEEK_START = "2031-06-01"; // Sunday
const WEEK_END = "2031-06-07"; // Saturday
// The Penda parser (parsePendaTrienda) coerces the Employee Number column
// through `String(Math.round(Number(empId)))`, so the seeded driver id has
// to be all digits. Use a high prefix that's well outside the real KFI
// roster range to avoid colliding with production driver ids.
const DRIVER = {
  kfiId: `9${Date.now()}`,
  name: "Bulk Upload Tester",
  customer: "Penda",
};

// Filenames keep the SUFFIX so the cleanup query in afterAll has something
// stable to target if a test crash leaves rows behind.
const PENDA_FILE = `penda-${SUFFIX}.xlsx`;
const UNKNOWN_PDF_FILE = `random-export-${SUFFIX}.pdf`;
const BOGUS_EXT_FILE = `notes-${SUFFIX}.txt`;
const IWG_BAD_FILE = `iwg-broken-${SUFFIX}.pdf`;

function buildPendaXlsx(kfiId: string): Buffer {
  // The Penda parser (parsePendaTrienda in
  // artifacts/api-server/src/lib/parsers/xlsx.ts) requires headers:
  //   Employee Number, Date, Time Start, Time End, Hours, Pay Category.
  // It treats the Employee Number as a payroll id and falls back to
  // `kfiSet.has(empId)` when EMBEDDED_MAPPING has no entry — so we use the
  // seeded driver's kfiId as the Employee Number and it lands directly.
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
  // Drop anything this test (or a prior crashed run with the same SUFFIX)
  // could have written. Match the file_origin column on the SUFFIX so we
  // don't disturb unrelated punches that happen to share the test week.
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

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("bulk upload classifies, uploads, and summarizes a mixed batch", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto(`/weeks/${WEEK_START}`);
  await page.waitForLoadState("networkidle");

  // Wait for the customer-upload panel + its bulk picker button to render.
  const bulkButton = page.getByRole("button", {
    name: /Upload all customer files/,
  });
  await expect(bulkButton).toBeVisible();

  // Build the four input files. The bulk picker accepts `.pdf,.xlsx,.xls`,
  // but Playwright's setInputFiles bypasses that filter — so the bogus
  // `.txt` file still reaches the client classifier, which marks it
  // unknown (extension check in classifyFile).
  const pendaBuf = buildPendaXlsx(DRIVER.kfiId);
  const unknownPdf = Buffer.from(
    "%PDF-1.4\n% e2e bulk-upload unknown placeholder\n%%EOF\n",
  );
  const bogusTxt = Buffer.from(
    `Just a notes file — should not be classified.\n${SUFFIX}\n`,
  );
  // Deliberately *not* a valid PDF body; pdfjs will throw, IWG parser will
  // propagate, server returns 400 → bulk marks this row as a failure.
  const iwgBad = Buffer.from(
    `not a real pdf — iwg routing on filename only (${SUFFIX})`,
  );

  // The bulk <input> is rendered hidden; locate it via its `accept` attr
  // so we don't fight the button click. Then push all four files at once.
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
    {
      name: UNKNOWN_PDF_FILE,
      mimeType: "application/pdf",
      buffer: unknownPdf,
    },
    {
      name: BOGUS_EXT_FILE,
      mimeType: "text/plain",
      buffer: bogusTxt,
    },
    {
      name: IWG_BAD_FILE,
      mimeType: "application/pdf",
      buffer: iwgBad,
    },
  ]);

  // The header switches to "Uploading…" while the loop runs, then to
  // "Bulk upload results" once it settles.
  const resultsHeading = page.getByRole("heading", {
    name: "Bulk upload results",
  });
  await expect(resultsHeading).toBeVisible({ timeout: 30_000 });

  // Scope row lookups to the bulk-results panel so we don't accidentally
  // match the main customer-files panel rows below it (which surface the
  // same filename in a "Last upload failed" / "Imported" badge). The bulk
  // results <ul> is the sibling of the heading's wrapper div — two divs
  // up from the <h4>.
  const bulkList = resultsHeading.locator("xpath=../../ul");
  const bulkRow = (fileName: string) =>
    bulkList.locator("li", { hasText: fileName });

  // 1. Penda success row: includes the source filename badge and the
  //    "<n> punches imported" caption. We seeded exactly one importable
  //    row so it should be "1 punches imported".
  const pendaRow = bulkRow(PENDA_FILE);
  await expect(pendaRow).toBeVisible();
  await expect(pendaRow).toContainText("Penda");
  await expect(pendaRow).toContainText("1 punches imported");

  // 2. Unknown-by-filename PDF: marked unknown client-side, never hits
  //    the server, and renders the "New customer file…" shortcut button.
  const unknownRow = bulkRow(UNKNOWN_PDF_FILE);
  await expect(unknownRow).toBeVisible();
  await expect(unknownRow).toContainText(
    "Not a known customer — use the new-customer flow to map it.",
  );
  await expect(
    unknownRow.getByRole("button", { name: /New customer file/ }),
  ).toBeVisible();

  // 3. Bogus extension: same unknown branch (extension check rejects).
  const bogusRow = bulkRow(BOGUS_EXT_FILE);
  await expect(bogusRow).toBeVisible();
  await expect(bogusRow).toContainText(
    "Not a known customer — use the new-customer flow to map it.",
  );
  await expect(
    bogusRow.getByRole("button", { name: /New customer file/ }),
  ).toBeVisible();

  // 4. IWG-named garbage PDF: routes client-side as IWG, server-side
  //    parser throws → row shows an error.
  const iwgRow = bulkRow(IWG_BAD_FILE);
  await expect(iwgRow).toBeVisible();
  await expect(iwgRow).toContainText("International Wire Group");

  // 5. Summary toast — the bulk handler renders a single toast with the
  //    rollup counts. We check the description text, not the variant.
  await expect(
    page
      .getByText("1 uploaded, 2 need review, 1 failed.", { exact: true })
      .first(),
  ).toBeVisible();

  // 6. The Penda punch actually landed in the DB (proves the file made
  //    the round trip end-to-end, not just the UI).
  const punchCount = await pool
    .query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM punches
         WHERE week_start = $1 AND kfi_id = $2 AND source = 'Customer'`,
      [WEEK_START, DRIVER.kfiId],
    )
    .then((r) => Number(r.rows[0].count));
  expect(punchCount).toBe(1);
});
