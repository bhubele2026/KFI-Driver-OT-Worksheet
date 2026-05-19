/**
 * End-to-end coverage for the hidden-notes admin flow
 * (artifacts/kfi-ot/src/pages/admin-deleted-notes.tsx + the
 * /api/notes/:id and /api/notes/:id/restore routes).
 *
 * Verifies:
 *   - As an admin, an inline week-level note added on the driver-detail
 *     page can be soft-deleted (hidden) and disappears from the live
 *     notes list.
 *   - The hidden note appears on /admin/notes with the seeded driver +
 *     week + body visible in its row.
 *   - Clicking Restore brings the note back live on the driver-detail
 *     page and removes it from the hidden listing.
 *
 * Seeds an isolated week + driver via direct DB writes so the test does
 * not depend on existing data; cleans up notes + driver + week
 * afterwards.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the admin-deleted-notes e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-04-20";
const WEEK_END = "2031-04-26";
const SUFFIX = `e2e-hn-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-HN-${SUFFIX}`,
  name: "Hidden Notes Tester",
  customer: "Adient",
};
const NOTE_BODY = `Hidden-notes e2e marker ${SUFFIX}`;

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
    `DELETE FROM driver_notes WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER.kfiId],
  );
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

test("admin can hide a note, see it on /admin/notes, and restore it", async ({
  page,
}) => {
  // Auto-accept the native window.confirm fired by the hide button.
  page.on("dialog", (d) => {
    void d.accept();
  });

  // Trigger the dev auth bypass so subsequent requests are authenticated
  // as an admin.
  await signInAsDispatcher(page);

  // 1. Add a week-level note on driver-detail.
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`);
  await expect(page.getByRole("heading", { name: DRIVER.name })).toBeVisible();

  await page.getByTestId("input-week-note").fill(NOTE_BODY);
  await page.getByTestId("button-submit-week-note").click();

  // The note item appears in the Notes card.
  const liveNote = page.locator('[data-testid^="note-item-"]', {
    hasText: NOTE_BODY,
  });
  await expect(liveNote).toBeVisible();

  // Look up the freshly-created note's id from the DB so we can target
  // its delete/restore buttons by stable testid.
  const noteId = await pool
    .query<{ id: number }>(
      `SELECT id FROM driver_notes
        WHERE week_start = $1 AND kfi_id = $2 AND body = $3
        ORDER BY id DESC LIMIT 1`,
      [WEEK_START, DRIVER.kfiId, NOTE_BODY],
    )
    .then((r) => r.rows[0].id);

  // 2. Hide the note (admin soft-delete). It disappears from the live list.
  await page.getByTestId(`button-delete-note-${noteId}`).click();
  await expect(page.getByTestId(`note-item-${noteId}`)).toHaveCount(0);

  // DB confirms the row is soft-deleted, not hard-deleted.
  const afterHide = await pool.query<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM driver_notes WHERE id = $1`,
    [noteId],
  );
  expect(afterHide.rows[0].deleted_at).not.toBeNull();

  // 3. /admin/notes lists the hidden note with the right metadata.
  await page.goto("/admin/notes");
  await expect(
    page.getByRole("heading", { name: "Admin · Hidden notes" }),
  ).toBeVisible();

  const hiddenRow = page.getByTestId(`row-deleted-note-${noteId}`);
  await expect(hiddenRow).toBeVisible();
  await expect(hiddenRow).toContainText(DRIVER.kfiId);
  await expect(hiddenRow).toContainText(WEEK_START);
  await expect(hiddenRow).toContainText(NOTE_BODY);

  // 4. Restore the note. The row disappears from the hidden listing.
  await page.getByTestId(`button-restore-note-${noteId}`).click();
  await expect(page.getByTestId(`row-deleted-note-${noteId}`)).toHaveCount(0);

  // DB confirms deleted_at was cleared.
  const afterRestore = await pool.query<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM driver_notes WHERE id = $1`,
    [noteId],
  );
  expect(afterRestore.rows[0].deleted_at).toBeNull();

  // 5. Driver-detail shows the restored note live again, with the
  // admin-only "previously hidden by …" audit tag inline on the note
  // (driven by driver_notes.last_hidden_{at,by_user_id} which persist
  // across restore).
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVER.kfiId}`);
  await expect(page.getByRole("heading", { name: DRIVER.name })).toBeVisible();
  await expect(page.getByTestId(`note-item-${noteId}`)).toBeVisible();
  await expect(page.getByTestId(`note-item-${noteId}`)).toContainText(NOTE_BODY);
  await expect(
    page.getByTestId(`note-previously-hidden-${noteId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`note-previously-hidden-${noteId}`),
  ).toContainText("previously hidden by");
});
