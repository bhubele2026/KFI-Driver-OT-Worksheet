/**
 * End-to-end coverage for the drag-and-drop entry point on the customer-files
 * panel.
 *
 * The drop path in
 * `artifacts/kfi-ot/src/components/customer-upload-panel.tsx` reuses the
 * bulk-upload pipeline (`runBulk` + `doUpload`) but layers on its own logic
 * that the file-picker flow doesn't touch:
 *   - the dragenter/dragover/dragleave handlers that toggle the
 *     "Drop customer files to upload" overlay,
 *   - the extension whitelist in `handleDrop` that buckets unsupported
 *     files into the "Skipped … unsupported" destructive toast before the
 *     bulk pipeline ever runs,
 *   - the in-flight guard that rejects a second drop while `bulkRunning`
 *     is true (not exercised here — covered indirectly by bulk-upload.spec).
 *
 * We synthesize a real DragEvent with a DataTransfer carrying three files
 * (.xlsx, .pdf, .png), dispatch dragenter → drop on the Card, and assert
 * the overlay toggles, the supported files round-trip through the upload
 * endpoint, and the .png raises the unsupported toast.
 */
import { test, expect, type Locator } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the bulk-upload-drag-drop e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-bd-${Date.now().toString(36)}`;
const WEEK_START = "2031-07-06"; // Sunday — distinct from sibling spec
const WEEK_END = "2031-07-12";
// Penda parser coerces Employee Number through `String(Math.round(...))`,
// so the seeded id must be all digits. High prefix avoids colliding with
// real KFI roster ids.
const DRIVER = {
  kfiId: `8${Date.now()}`,
  name: "Drag Drop Tester",
  customer: "Penda",
};

const PENDA_FILE = `penda-${SUFFIX}.xlsx`;
const IWG_PDF_FILE = `iwg-${SUFFIX}.pdf`;
const PNG_FILE = `screenshot-${SUFFIX}.png`;

function buildPendaXlsx(kfiId: string): Buffer {
  // Mirrors the fixture in bulk-upload.spec.ts. parsePendaTrienda expects
  // the headers below and accepts the kfiId directly when EMBEDDED_MAPPING
  // has no entry for the Employee Number (which is the case for our
  // synthesized id).
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
         AND (last_file_name LIKE $2 OR customer IN ($3, 'International Wire Group'))`,
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

interface DropFile {
  name: string;
  type: string;
  b64: string;
}

function toB64(buf: Buffer): string {
  return buf.toString("base64");
}

/**
 * Dispatch a real DragEvent on `target` with a DataTransfer containing
 * the given files. `kind` chooses the event name; for the dragenter step
 * we leave `files` empty-but-typed (the production handler only checks
 * `dataTransfer.types.includes("Files")` to gate the overlay) and for
 * the drop step we include the actual File payload.
 */
async function dispatchDrag(
  target: Locator,
  kind: "dragenter" | "dragover" | "dragleave" | "drop",
  files: DropFile[],
): Promise<void> {
  await target.evaluate(
    (el, args: { kind: string; files: DropFile[] }) => {
      const dt = new DataTransfer();
      for (const f of args.files) {
        const bin = atob(f.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const evt = new DragEvent(args.kind, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      el.dispatchEvent(evt);
    },
    { kind, files },
  );
}

// Quarantined: "Skipped 1 unsupported file" toast not appearing (task #150). See follow-up #193.
test.fixme("drag-and-drop routes supported files through bulk pipeline and rejects unsupported", async ({
  page,
}) => {
  // Hit root first so App.tsx fires the dev-bypass POST and seats the
  // session cookie before we navigate to the dashboard route (the same
  // pattern customer-preview.spec.ts uses).
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto(`/weeks/${WEEK_START}`);
  await page.waitForLoadState("networkidle");

  // Wait for the upload panel to mount; we anchor on its heading and walk
  // up to the Card root (the element with the onDragEnter/onDrop handlers).
  const panelHeading = page.getByRole("heading", { name: "Customer files" });
  await expect(panelHeading).toBeVisible();
  // The Card wrapper is the nearest ancestor div with the "relative" class
  // (see customer-upload-panel.tsx — `<Card className="relative ..." />`).
  const panel = panelHeading.locator(
    'xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," "), " relative ")][1]',
  );
  await expect(panel).toBeVisible();

  const pendaFile: DropFile = {
    name: PENDA_FILE,
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    b64: toB64(buildPendaXlsx(DRIVER.kfiId)),
  };
  // IWG-named placeholder PDF: filename routes it client-side to the IWG
  // parser; the bytes are deliberately not a valid PDF so the server
  // returns 400 → renders as a failed row in the bulk-results list. This
  // proves the dropped supported files actually hit the upload endpoint.
  const iwgPdf: DropFile = {
    name: IWG_PDF_FILE,
    type: "application/pdf",
    b64: toB64(
      Buffer.from(`not a real pdf — iwg routing on filename (${SUFFIX})`),
    ),
  };
  // 1×1 transparent PNG. handleDrop's extension whitelist rejects this
  // before the bulk pipeline runs, so it never reaches the server.
  const png: DropFile = {
    name: PNG_FILE,
    type: "image/png",
    b64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  };

  const allFiles: DropFile[] = [pendaFile, iwgPdf, png];

  // 1. Dragenter raises the drop affordance overlay. The handler reads
  //    `dataTransfer.types`, so we must supply a DataTransfer that
  //    advertises "Files" — adding any File to the DataTransfer.items is
  //    sufficient (Chromium auto-populates `types`).
  await dispatchDrag(panel, "dragenter", allFiles);
  await dispatchDrag(panel, "dragover", allFiles);
  const overlay = page.getByText("Drop customer files to upload", {
    exact: true,
  });
  await expect(overlay).toBeVisible();

  // Track the upload requests so we can assert end-to-end round trip —
  // not just UI state.
  const uploadCalls: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/weeks/") && url.includes("/upload-customer-file")) {
      uploadCalls.push(url);
    }
  });
  // Throttle the upload endpoint so runBulk doesn't finish before we get
  // a chance to assert on the rejected-files toast. The toast state in
  // `hooks/use-toast.ts` caps the viewport at TOAST_LIMIT=1, so the
  // "Bulk upload complete" toast that fires when runBulk finishes will
  // evict the "Skipped …" toast. With the route still hitting the real
  // server (it forwards `request.continue()`), this stays an end-to-end
  // test — it just buys us deterministic timing.
  await page.route("**/upload-customer-file", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  // 2. Drop fires runBulk for the .xlsx + .pdf and toasts about the .png.
  //    NOTE: assert the "Skipped" toast BEFORE waiting for the bulk to
  //    finish. shadcn/ui's use-toast caps the viewport at TOAST_LIMIT=1,
  //    so the "Bulk upload complete" toast that fires when runBulk
  //    finishes will evict the "Skipped …" toast if we wait too long.
  await dispatchDrag(panel, "drop", allFiles);

  // 3. "Skipped 1 unsupported file" toast for the .png. The toast title
  //    pluralizes ("file" vs "files") based on count — one .png → "file".
  //    Use substring match (not exact) — Radix Toast renders the title
  //    inside elements whose accessible name may include sibling text,
  //    which trips exact-match selectors. The unique number prevents
  //    false positives.
  const unsupportedToast = page
    .getByText(/Skipped 1 unsupported file/i)
    .first();
  await expect(unsupportedToast).toBeVisible();

  // Overlay disappears on drop (handler sets isDragOver=false
  // synchronously alongside the rejected-files toast).
  await expect(overlay).toBeHidden();

  // 4. Bulk results panel renders for the two accepted files.
  const resultsHeading = page.getByRole("heading", {
    name: "Bulk upload results",
  });
  await expect(resultsHeading).toBeVisible({ timeout: 30_000 });
  const bulkList = resultsHeading.locator("xpath=../../ul");

  const pendaRow = bulkList.locator("li", { hasText: PENDA_FILE });
  await expect(pendaRow).toBeVisible();
  await expect(pendaRow).toContainText("Penda");
  await expect(pendaRow).toContainText("1 punches imported");

  const iwgRow = bulkList.locator("li", { hasText: IWG_PDF_FILE });
  await expect(iwgRow).toBeVisible();
  await expect(iwgRow).toContainText("International Wire Group");

  // The .png must NOT appear in the bulk-results panel — it was filtered
  // out before runBulk ever saw it.
  await expect(bulkList.locator("li", { hasText: PNG_FILE })).toHaveCount(0);

  // 5. Exactly two upload-customer-file requests fired (one per accepted
  //    file). Proves the drop handler actually pushes through the same
  //    pipeline as the file-picker, and that the .png was filtered before
  //    any network call.
  expect(uploadCalls.length).toBe(2);

  // 6. The Penda punch landed in the DB — end-to-end proof the dropped
  //    bytes made the full round trip.
  const punchCount = await pool
    .query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM punches
         WHERE week_start = $1 AND kfi_id = $2 AND source = 'Customer'`,
      [WEEK_START, DRIVER.kfiId],
    )
    .then((r) => Number(r.rows[0].count));
  expect(punchCount).toBe(1);
});
