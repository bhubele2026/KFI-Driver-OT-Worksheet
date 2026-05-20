/**
 * End-to-end coverage for the "self-onboarding new customer" flow on the
 * dispatcher week dashboard, exercised against the REAL Penda xlsx
 * fixture (`artifacts/api-server/src/lib/parsers/__tests__/fixtures/2026-04-26/Penda.xlsx`).
 *
 * The loop a dispatcher walks for a brand-new customer:
 *
 *   1. Admin opens `/admin/customers` and registers the customer
 *      (display name, filename keywords, extensions). We POST through
 *      the admin API for speed; the form has its own coverage.
 *   2. On the week dashboard the customer's row appears in the
 *      customer-upload panel; dispatcher uploads the file via the
 *      per-row hidden input → server routes to `/extract-customer-file`
 *      with the explicit `customer` field → AI extraction runs.
 *      Real Gemini is called here — task #289 explicitly accepts that
 *      risk; the fake-Gemini mode lives in follow-up #285.
 *   3. The preview dialog renders the picker with the "Read by: AI"
 *      chip and a `row-unmapped-*` entry for the badge we deliberately
 *      left out of the seeded roster. Dispatcher opens the Radix Select
 *      trigger, picks the seeded `PICK_TARGET_DRIVER`, and clicks
 *      "Confirm import" — same buttons a human uses.
 *   4. Punches land in the DB; the pick wrote `driver_id_aliases` so a
 *      subsequent upload would auto-resolve the same badge.
 *   5. Dispatcher re-uploads the same file (via `extract-customer-file?force=1`
 *      so we skip the SHA-256 dedupe shortcut and actually exercise the
 *      cache reader). The column-schema cache hits
 *      (`extractSource === "cache"`), no AI call fires, no picker rows
 *      surface, and confirming again is a no-op (wipe-and-reinsert with
 *      identical rows).
 *
 * Scoped cleanup only: drops the customer row, its aliases, schemas, AI
 * sample rows, the rate-limit / upload-attempts rows for the test week,
 * and the seeded drivers / week. We never TRUNCATE shared tables.
 *
 * Strategy for keeping the picker tractable on a 450-row / 77-driver
 * fixture: seed every distinct employee number in the fixture as a
 * roster driver EXCEPT one — that one survives as the single picker
 * prompt the test drives via the Radix Select. Stub drivers we create
 * are tagged with the test suffix so cleanup deletes exactly what we
 * inserted (idempotent across reruns, never touches real data).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EPool } from "./_helpers/db";
import * as XLSX from "xlsx";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const SUFFIX = `e2e-onb-pen-${Date.now().toString(36)}`;
// Must match the fixture's actual week — Gemini reads the dates straight
// off the sheet and the extractor drops anything outside the requested
// Sun→Sat window. The fixture lives under `fixtures/2026-04-26/`, so the
// dispatcher session reconciles that exact week.
const WEEK_START = "2026-04-26"; // Sunday
const WEEK_END = "2026-05-02"; // Saturday

// Unique customer + keyword: never collides with the seeded "Penda"
// customer (display name "Penda", keyword "penda") and survives
// parallel runs because the suffix is per-process.
const CUSTOMER_NAME = `E2E Penda ${SUFFIX}`;
const KEYWORD = `penda${SUFFIX.replace(/-/g, "")}`.toLowerCase();

// Seeded driver that the picker pick targets. They get a Driver-source
// punch in seedDb so the candidate-pool filter keeps them selectable.
// kfi_id uses a synthetic id space (`E2E-…`) that real Connecteam
// badge numbers (always numeric) cannot collide with. See `STUB_KFI`
// below — same rule applies to every driver seeded by this spec.
const PICK_TARGET_DRIVER = {
  kfiId: `E2E-${SUFFIX}-PICK`,
  name: `E2E Pick Target ${SUFFIX}`,
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
  "Penda.xlsx",
);
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH);
const FILE_NAME = `${KEYWORD}.xlsx`;

// Extract distinct employee numbers from the fixture once, at module
// load. Sorting makes the "which one stays unmapped" pick deterministic
// across runs (the first id sorted lexicographically).
function distinctEmployeeNumbers(): string[] {
  const wb = XLSX.read(FIXTURE_BYTES, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });
  const ids = new Set<string>();
  for (const r of rows) {
    const raw = r["Employee Number"];
    if (raw == null || raw === "") continue;
    ids.add(String(raw));
  }
  return [...ids].sort();
}

const ALL_EMPS = distinctEmployeeNumbers();
const UNMAPPED_BADGE = ALL_EMPS[0]!;
const MAPPED_EMPS = ALL_EMPS.slice(1);

// Stub driver name marker — used in cleanup to delete only the rows we
// inserted, regardless of whether ON CONFLICT DO NOTHING actually wrote
// the row (real existing drivers with the same kfi_id are untouched).
const STUB_NAME_PREFIX = `E2E Penda Stub ${SUFFIX}`;

// Map a real fixture badge id to the synthetic stub kfi_id it resolves
// to. Connecteam badge ids are numeric, so the `E2E-…` prefix
// guarantees no collision with any real driver — even if an alias or
// driver row ever leaks past the cleanup it can't be looked up as a
// real badge again. Resolution is wired via `driver_id_aliases`
// (real_badge → synthetic stub kfi).
const STUB_KFI = (emp: string): string => `E2E-${SUFFIX}-${emp}`;

async function seedDb(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  // Pick target driver — used by the UI picker dropdown. Uses a
  // synthetic kfi_id (see PICK_TARGET_DRIVER) so it can never collide
  // with a real Connecteam badge.
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO UPDATE
       SET name = EXCLUDED.name, customer = EXCLUDED.customer,
           is_archived = false`,
    [PICK_TARGET_DRIVER.kfiId, PICK_TARGET_DRIVER.name, CUSTOMER_NAME],
  );
  // Stub-seed every fixture employee number EXCEPT the chosen unmapped
  // one — but using SYNTHETIC kfi_ids in the `E2E-…` namespace, not
  // the real badge numbers. We then wire a `driver_id_aliases` row
  // mapping the real badge → synthetic stub kfi so the extractor
  // resolves the fixture row exactly as before. This way even if a
  // future leak slips past the gate, the rows we drop in the DB can't
  // accidentally shadow a real Connecteam driver.
  for (const emp of MAPPED_EMPS) {
    await pool.query(
      `INSERT INTO drivers (kfi_id, name, customer)
         VALUES ($1, $2, $3)
       ON CONFLICT (kfi_id) DO NOTHING`,
      [STUB_KFI(emp), `${STUB_NAME_PREFIX} ${emp}`, CUSTOMER_NAME],
    );
    await pool.query(
      `INSERT INTO driver_id_aliases (customer, external_id, kfi_id)
         VALUES ($1, $2, $3)
       ON CONFLICT (external_id) DO UPDATE
         SET kfi_id = EXCLUDED.kfi_id, customer = EXCLUDED.customer`,
      [CUSTOMER_NAME, emp, STUB_KFI(emp)],
    );
  }
  // Driver-source punch so the candidate-pool filter keeps the pick
  // target selectable in the unmapped-id picker dropdown.
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
  // Drop punches for the test week scoped to our customer and to the
  // stub drivers we created. The pick target gets its own delete.
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = $2`,
    [WEEK_START, CUSTOMER_NAME],
  );
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, PICK_TARGET_DRIVER.kfiId],
  );
  await pool.query(
    `DELETE FROM punches
       WHERE week_start = $1
         AND kfi_id IN (SELECT kfi_id FROM drivers WHERE name LIKE $2)`,
    [WEEK_START, `${STUB_NAME_PREFIX}%`],
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
  // Aliases the picker write (and any leftovers from a prior crashed
  // run). Customer name is unique per run, but the badge id is shared
  // across runs — once the picker writes alias UNMAPPED_BADGE → driver
  // (scoped to that prior run's customer), the global unique index on
  // lower(external_id) makes the alias survive future runs and turns
  // the badge into a pre-mapped row, breaking Step 3's
  // exactly-one-unmapped-row expectation. Delete by external_id too.
  await pool.query(
    `DELETE FROM driver_id_aliases WHERE customer = $1 OR external_id = $2`,
    [CUSTOMER_NAME, UNMAPPED_BADGE],
  );
  await pool.query(
    `DELETE FROM customers WHERE display_name = $1`,
    [CUSTOMER_NAME],
  );
  // Delete only the stubs we created (matched by the suffix marker).
  await pool.query(
    `DELETE FROM drivers WHERE name LIKE $1`,
    [`${STUB_NAME_PREFIX}%`],
  );
  await pool.query(
    `DELETE FROM drivers WHERE kfi_id = $1`,
    [PICK_TARGET_DRIVER.kfiId],
  );
  // Intentionally do NOT delete the weeks row — 2026-04-26 is a real
  // payroll week that other data (and other tests) may reference. The
  // seedDb INSERT uses ON CONFLICT DO NOTHING so leaving the row in
  // place is correct and idempotent.
}

test.beforeAll(async () => {
  await cleanup();
  await seedDb();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

// Real Gemini on a 450-row xlsx: bump the per-test budget for the
// first-time AI pass (chunked extract can run 30-90s).
test.setTimeout(300_000);

// The unmapped-driver picker is a Radix Select with ~21 options that
// Radix renders in an absolutely-positioned popper anchored to the
// trigger. With the default 720px viewport the matching <Option> can
// land below the visible page rect; Playwright's click then fails
// with "Element is outside of the viewport" even after scrolling
// Radix's internal scroll viewport (and even with force:true — CDP
// still needs to dispatch the click at an in-viewport point). A
// taller viewport lets the popper render the full option list
// on-screen.
test.use({ viewport: { width: 1280, height: 1800 } });

test("dispatcher self-onboards a new Penda customer end-to-end with real fixture + UI picker", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  // ----- Step 1: admin registers the customer via the admin API ------
  const createRes = await page.request.post("/api/admin/customers", {
    data: {
      displayName: CUSTOMER_NAME,
      filenameKeywords: [KEYWORD],
      extensions: ["xlsx"],
      active: true,
      sortOrder: 990,
    },
  });
  expect(createRes.status()).toBe(200);
  const customerId = await getCustomerId();
  expect(customerId).not.toBeNull();

  // The admin form (used by humans) renders the row.
  await page.goto("/admin/customers", { waitUntil: "commit" });
  await expect(page.getByTestId(`customer-name-${customerId}`)).toHaveValue(
    CUSTOMER_NAME,
  );

  // ----- Step 2: dispatcher uploads via the per-row UI ----------------
  await page.goto(`/weeks/${WEEK_START}`, { waitUntil: "commit" });
  // Scope to the upload-panel row testid — the customer name also
  // shows up in the drivers-sidebar `<li>` (groupings by customer),
  // which would otherwise be picked first and contains no file input.
  const customerRow = page.getByTestId(`customer-upload-row-${CUSTOMER_NAME}`);
  await expect(customerRow).toBeVisible({ timeout: 30_000 });

  const fileInput = page.getByTestId(`customer-upload-input-${CUSTOMER_NAME}`);
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles({
    name: FILE_NAME,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: FIXTURE_BYTES,
  });

  // ----- Step 3: preview opens, AI source, single picker prompt ------
  const previewDialog = page.getByRole("dialog", {
    name: new RegExp(`Review ${CUSTOMER_NAME} upload`, "i"),
  });
  // First-time AI extract on the full 450-row fixture can take a while.
  await expect(previewDialog).toBeVisible({ timeout: 240_000 });
  await expect(previewDialog.getByTestId("text-extract-source")).toContainText(
    "AI",
  );
  // recordAiSchemaIfPossible writes a column-schema row for the
  // header signature on the AI path — surfaces here as the "next
  // upload will be instant" chip. Pins the cache write happened before
  // the dialog rendered.
  await expect(
    previewDialog.getByTestId("chip-cache-warmed"),
  ).toBeVisible();

  // Exactly one unmapped row — the badge we withheld from the roster.
  // (The candidate-pool filter is `drivers who punched this week via
  // Driver source`, so the dropdown surfaces only the pick target plus
  // the standard "Skip" / "Not a driver" choices.)
  const unmappedRow = previewDialog.getByTestId(
    `row-unmapped-${UNMAPPED_BADGE}`,
  );
  await expect(unmappedRow).toBeVisible();

  // ----- Step 4: drive the Radix Select via UI, then UI Confirm ------
  await previewDialog
    .getByTestId(`select-unmapped-${UNMAPPED_BADGE}`)
    .click();
  // Radix Select renders the options portal-attached to <body>, not
  // inside the dialog. Scope the option click to the open listbox.
  const optionList = page.getByRole("listbox");
  await expect(optionList).toBeVisible();
  // Radix Select's Popper positions the listbox absolute-anchored to
  // the trigger; the matching <Option> may render at a y-coordinate
  // past the visible page rect even with a tall viewport (the popper
  // can spill below the bottom edge of the dialog's own scroll
  // viewport). Playwright's CDP click requires an in-viewport point
  // even with force:true. Radix's SelectItem listens for pointerup
  // (via radix-collection-item) — dispatch the same synthetic event
  // sequence directly on the element so position doesn't matter.
  const option = optionList.getByRole("option", {
    name: new RegExp(PICK_TARGET_DRIVER.name, "i"),
  });
  await option.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    const opts = { bubbles: true, cancelable: true } as const;
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  });
  // Selection rendered back in the trigger.
  await expect(
    previewDialog.getByTestId(`select-unmapped-${UNMAPPED_BADGE}`),
  ).toContainText(PICK_TARGET_DRIVER.name);

  await previewDialog.getByTestId("button-confirm-import").click();
  await expect(previewDialog).not.toBeVisible();

  // The picker write created the badge alias (auto-learn for badges
  // attached to a pending-named-row resolution).
  const aliasAfter = await pool.query<{ kfi_id: string }>(
    `SELECT kfi_id FROM driver_id_aliases WHERE external_id = $1`,
    [UNMAPPED_BADGE],
  );
  expect(aliasAfter.rows[0]?.kfi_id).toBe(PICK_TARGET_DRIVER.kfiId);

  // Punches landed for the pick target. We don't assert an exact total
  // across all 77 drivers — the AI's row-level deduping is
  // non-deterministic on a fixture this size — but the picker
  // round-trip lands at least one row for the picked driver.
  const pickPunches = await pool
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM punches
         WHERE week_start = $1 AND customer = $2 AND source = 'Customer'
           AND kfi_id = $3`,
      [WEEK_START, CUSTOMER_NAME, PICK_TARGET_DRIVER.kfiId],
    )
    .then((r) => Number(r.rows[0].n));
  expect(pickPunches).toBeGreaterThan(0);
  // Sanity: some of the auto-mapped (stub-seeded) drivers also got
  // punches — i.e. the path is end-to-end, not just the picker row.
  const totalCustomerPunches = await pool
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM punches
         WHERE week_start = $1 AND customer = $2 AND source = 'Customer'`,
      [WEEK_START, CUSTOMER_NAME],
    )
    .then((r) => Number(r.rows[0].n));
  expect(totalCustomerPunches).toBeGreaterThan(pickPunches);

  // ----- Step 5: second upload = column-schema cache hit, no AI ------
  // `?force=1` bypasses the SHA-256 dedupe shortcut so we actually
  // exercise the cache reader (instead of a `skipped: true`
  // short-circuit).
  const reExtractRes = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file?force=1`,
    {
      multipart: {
        file: {
          name: FILE_NAME,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: FIXTURE_BYTES,
        },
        customer: CUSTOMER_NAME,
      },
    },
  );
  expect(reExtractRes.status()).toBe(200);
  const reBody = (await reExtractRes.json()) as {
    sampleId: number;
    rows: Array<{ index: number }>;
    unmappedIds: Array<{ id: string }>;
    extractSource: "cache" | "ai";
  };
  expect(reBody.extractSource).toBe("cache");
  // Every formerly-unmapped badge now resolves through the alias the
  // picker wrote, so the cache-reader sees no unmapped IDs.
  expect(reBody.unmappedIds).toEqual([]);
  expect(reBody.rows.length).toBeGreaterThan(0);

  // Confirm the cache-hit preview through the API (the dialog code
  // path is already covered by the first confirm above).
  const reConfirmRes = await page.request.post(
    `/api/weeks/${WEEK_START}/confirm-customer-file`,
    {
      data: {
        customer: CUSTOMER_NAME,
        sampleId: reBody.sampleId,
        excludedIndices: [],
      },
    },
  );
  expect(reConfirmRes.status()).toBe(200);
});
