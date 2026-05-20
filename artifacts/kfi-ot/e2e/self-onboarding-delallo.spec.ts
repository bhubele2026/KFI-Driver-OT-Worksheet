/**
 * End-to-end coverage for the "self-onboarding new customer" flow on the
 * dispatcher week dashboard, exercised against the REAL DeLallo PDF
 * fixture (`artifacts/api-server/src/lib/parsers/__tests__/fixtures/2026-04-26/DeLallo.pdf`).
 *
 * Companion to self-onboarding-penda.spec.ts (xlsx). The xlsx spec pins
 * the column-schema cache path (`extractSource === "cache"`) because
 * `recordAiSchemaIfPossible` only writes for tabular files with a
 * matchable header signature. PDFs always go through Gemini, so the
 * "second upload = no AI call" assertion here is the SHA-256-based
 * dedupe shortcut in `/extract-customer-file`: an identical re-upload
 * (without `?force=1`) returns `{ skipped: true }` with no Gemini call
 * and no new stash.
 *
 * Same scoped-cleanup rules as the Penda spec — never TRUNCATEs shared
 * tables. Real Gemini is called once per run; allowed in CI per task
 * #289 (fake-Gemini lives in follow-up #285).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const SUFFIX = `e2e-onb-del-${Date.now().toString(36)}`;
const WEEK_START = "2031-09-14"; // Sunday
const WEEK_END = "2031-09-20"; // Saturday
const CUSTOMER_NAME = `E2E DeLallo ${SUFFIX}`;
const KEYWORD = `delallo${SUFFIX.replace(/-/g, "")}`.toLowerCase();

// Synthetic kfi_id (`E2E-…`) lives in a namespace real Connecteam
// badge numbers (always numeric) cannot collide with — so if this stub
// driver ever leaks past cleanup, a real customer-file badge cannot
// resolve onto it. This is the only driver this spec seeds; the
// dispatcher picker maps every unmapped fixture row onto it via
// `customer_name_aliases` (DeLallo PDFs carry names, not badges).
const PICK_TARGET_DRIVER = {
  kfiId: `E2E-${SUFFIX}-PICK`,
  name: `E2E DeLallo Pick Target ${SUFFIX}`,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  here,
  "..",
  "..",
  "api-server",
  "src",
  "lib",
  "parsers",
  "__tests__",
  "fixtures",
  "2026-04-26",
  "DeLallo.pdf",
);
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH);
const FILE_NAME = `${KEYWORD}.pdf`;

async function seedDb(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO UPDATE
       SET name = EXCLUDED.name, customer = EXCLUDED.customer,
           is_archived = false`,
    [PICK_TARGET_DRIVER.kfiId, PICK_TARGET_DRIVER.name, CUSTOMER_NAME],
  );
  // Driver-source punch so the candidate-pool filter (drivers who
  // punched this week via Connecteam) keeps this driver as the only
  // selectable option in every picker dropdown.
  await pool.query(
    `INSERT INTO punches (week_start, kfi_id, source, date, clock_in, clock_out,
                          hours, is_manual)
       VALUES ($1, $2, 'Driver', $3, $4, $5, $6, false)`,
    [
      WEEK_START,
      PICK_TARGET_DRIVER.kfiId,
      WEEK_START,
      `${WEEK_START} 7:00 AM`,
      `${WEEK_START} 3:00 PM`,
      "8.000",
    ],
  );
}

async function getCustomerId(): Promise<number | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM customers WHERE display_name = $1`,
    [CUSTOMER_NAME],
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, CUSTOMER_NAME],
  );
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, PICK_TARGET_DRIVER.kfiId],
  );
  await pool.query(
    `DELETE FROM ai_extract_samples WHERE customer = $1`,
    [CUSTOMER_NAME],
  );
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, CUSTOMER_NAME],
  );
  await pool.query(
    `DELETE FROM customer_name_aliases WHERE customer = $1`,
    [CUSTOMER_NAME],
  );
  await pool.query(
    `DELETE FROM customer_column_schemas WHERE customer = $1`,
    [CUSTOMER_NAME],
  );
  // Aliases written by this run's picker carry our customer label.
  await pool.query(
    `DELETE FROM driver_id_aliases WHERE customer = $1`,
    [CUSTOMER_NAME],
  );
  await pool.query(
    `DELETE FROM customers WHERE display_name = $1`,
    [CUSTOMER_NAME],
  );
  await pool.query(
    `DELETE FROM drivers WHERE kfi_id = $1`,
    [PICK_TARGET_DRIVER.kfiId],
  );
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
}

test.beforeAll(async () => {
  await cleanup();
  await seedDb();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

// Real Gemini + a multi-page PDF: bump for the AI's image-extract pass.
test.setTimeout(300_000);

test("dispatcher self-onboards a new DeLallo customer end-to-end with real fixture + UI picker", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  // ----- Step 1: admin registers the customer -------------------------
  const createRes = await page.request.post("/api/admin/customers", {
    data: {
      displayName: CUSTOMER_NAME,
      filenameKeywords: [KEYWORD],
      extensions: ["pdf"],
      active: true,
      sortOrder: 990,
    },
  });
  expect(createRes.status()).toBe(200);
  const customerId = await getCustomerId();
  expect(customerId).not.toBeNull();

  // ----- Step 2: dispatcher uploads via the per-row UI ----------------
  await page.goto(`/weeks/${WEEK_START}`, { waitUntil: "commit" });
  const customerRow = page
    .locator("li")
    .filter({ hasText: CUSTOMER_NAME })
    .first();
  await expect(customerRow).toBeVisible({ timeout: 30_000 });

  const fileInput = customerRow.locator('input[type="file"]');
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles({
    name: FILE_NAME,
    mimeType: "application/pdf",
    buffer: FIXTURE_BYTES,
  });

  // ----- Step 3: preview opens, "AI" source chip, picker rows --------
  const previewDialog = page.getByRole("dialog", {
    name: new RegExp(`Review ${CUSTOMER_NAME} upload`, "i"),
  });
  // Multi-page PDF + AI image extract: be generous on the open.
  await expect(previewDialog).toBeVisible({ timeout: 240_000 });
  await expect(previewDialog.getByTestId("text-extract-source")).toContainText(
    "AI",
  );

  // DeLallo PDFs carry driver names but no badges that resolve against
  // a brand-new customer, so the picker MUST surface at least one
  // unmapped entry — otherwise this spec isn't exercising the picker.
  const unmappedRows = previewDialog.locator(
    '[data-testid^="row-unmapped-"]',
  );
  await expect(unmappedRows.first()).toBeVisible();

  // Pull every unmapped id off the DOM so we can drive each Radix
  // Select to the pick target. The candidate-pool filter narrows the
  // dropdown to just the seeded driver who punched this week — one
  // option per dropdown, so no virtualization concerns even with a
  // dozen unmapped rows.
  const unmappedIds = await unmappedRows.evaluateAll((nodes) =>
    nodes
      .map((n) => {
        const id = (n as HTMLElement).getAttribute("data-testid") ?? "";
        return id.replace(/^row-unmapped-/, "");
      })
      .filter((s) => s.length > 0),
  );
  expect(unmappedIds.length).toBeGreaterThan(0);

  // ----- Step 4: drive each picker via UI, then click Confirm import -
  for (const id of unmappedIds) {
    await previewDialog.getByTestId(`select-unmapped-${id}`).click();
    // Radix Select portals the options to <body>; scope to the open
    // listbox so we don't accidentally match an option in a stale
    // earlier popper.
    const optionList = page.getByRole("listbox");
    await expect(optionList).toBeVisible();
    await optionList
      .getByRole("option", { name: new RegExp(PICK_TARGET_DRIVER.name, "i") })
      .click();
    // Wait for the trigger to reflect the selection before opening the
    // next dropdown — keeps the action serialization clean on slow CI.
    await expect(
      previewDialog.getByTestId(`select-unmapped-${id}`),
    ).toContainText(PICK_TARGET_DRIVER.name);
  }

  await previewDialog.getByTestId("button-confirm-import").click();
  await expect(previewDialog).not.toBeVisible({ timeout: 60_000 });

  // At least one customer-source punch landed for the pick target —
  // proves the picker round-trip writes both aliases and punches.
  const punchesAfter = await pool
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM punches
         WHERE week_start = $1 AND customer = $2 AND source = 'Customer'
           AND kfi_id = $3`,
      [WEEK_START, CUSTOMER_NAME, PICK_TARGET_DRIVER.kfiId],
    )
    .then((r) => Number(r.rows[0].n));
  expect(punchesAfter).toBeGreaterThan(0);

  // Aliases (badge or name) were persisted for the dispatcher's picks
  // — scoped to our test customer so we don't accidentally count
  // background data.
  const aliasCount = await pool
    .query<{ n: string }>(
      `SELECT
         (SELECT count(*) FROM driver_id_aliases WHERE customer = $1)
         + (SELECT count(*) FROM customer_name_aliases WHERE customer = $1)
         AS n`,
      [CUSTOMER_NAME],
    )
    .then((r) => Number(r.rows[0].n));
  expect(aliasCount).toBeGreaterThan(0);

  // ----- Step 5: identical re-upload = SHA-256 skip, no AI call ------
  // Per-row upload from the UI doesn't pass `?force=1` (only the
  // explicit `Re-upload` button does), so an identical re-upload of
  // the same bytes against the same (week, customer) hits the dedupe
  // shortcut at the top of `/extract-customer-file` and returns
  // `{ skipped: true }` with sampleId === null — no Gemini call, no
  // new stash row.
  const samplesBefore = await pool
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_extract_samples WHERE customer = $1`,
      [CUSTOMER_NAME],
    )
    .then((r) => Number(r.rows[0].n));

  const skipRes = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file`,
    {
      multipart: {
        file: {
          name: FILE_NAME,
          mimeType: "application/pdf",
          buffer: FIXTURE_BYTES,
        },
        customer: CUSTOMER_NAME,
      },
    },
  );
  expect(skipRes.status()).toBe(200);
  const skipBody = (await skipRes.json()) as {
    skipped?: boolean;
    sampleId: number | null;
    unmappedIds: Array<unknown>;
  };
  expect(skipBody.skipped).toBe(true);
  expect(skipBody.sampleId).toBeNull();
  expect(skipBody.unmappedIds).toEqual([]);

  const samplesAfter = await pool
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_extract_samples WHERE customer = $1`,
      [CUSTOMER_NAME],
    )
    .then((r) => Number(r.rows[0].n));
  expect(samplesAfter).toBe(samplesBefore);
});
