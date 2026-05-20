/**
 * End-to-end coverage for the pinned top toolbar on the per-driver page
 * (artifacts/kfi-ot/src/pages/driver-detail.tsx).
 *
 * The dark header (Back / EN-ES / reviewed counter / Good-Bad / Lock /
 * Refresh / Add Punch / Print) must stay visibly pinned at the top of the
 * viewport while the punches list scrolls. Previously the outer page wrapper
 * was `min-h-[100dvh]` with no overflow constraint and the body scrolled,
 * which let the header drift away on some viewports. The shell was switched
 * to a fixed `h-[100dvh]` with `<main>` as the scroll container; this test
 * locks that behavior in.
 *
 * Seeds an isolated week with a single driver that has enough punches to
 * make the page taller than the viewport, scrolls `<main>`, and asserts the
 * header is still in its original position at the very top.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the driver-toolbar-pinned e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const WEEK_START = "2031-05-04";
const WEEK_END = "2031-05-10";
const SUFFIX = `e2e-pin-${Date.now().toString(36)}`;
const KFI_ID = `KFI-PIN-${SUFFIX}`;
const DRIVER_NAME = "Toolbar Pin Driver";

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
      [KFI_ID, DRIVER_NAME, "Adient"],
    );
    // 6 days × 5 short punches = 30 rows: easily taller than any viewport.
    for (let day = 0; day < 6; day++) {
      const dt = new Date(`${WEEK_START}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() + day);
      const iso = dt.toISOString().slice(0, 10);
      for (let i = 0; i < 5; i++) {
        const startHour = i + 1;
        await client.query(
          `INSERT INTO punches
             (week_start, kfi_id, customer, source, date,
              clock_in, clock_out, hours, is_manual)
           VALUES ($1::date, $2, $3, 'Driver', $4,
                   $5, $6, 1.0, true)`,
          [
            WEEK_START,
            KFI_ID,
            "Adient",
            iso,
            `${iso} ${startHour}:00 AM`,
            `${iso} ${startHour + 1}:00 AM`,
          ],
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM punches WHERE kfi_id = $1`, [KFI_ID]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [KFI_ID]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("driver page top toolbar stays pinned while punches scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${KFI_ID}`);
  await expect(
    page.getByRole("heading", { name: DRIVER_NAME }),
  ).toBeVisible();

  // The toolbar's "Refresh" + "Add Punch" buttons should be visible up top
  // before any scrolling.
  const refresh = page.getByRole("button", { name: /refresh/i });
  const addPunch = page.getByRole("button", { name: /add punch/i });
  await expect(refresh).toBeVisible();
  await expect(addPunch).toBeVisible();

  // Confirm the page actually has scrollable content inside <main>.
  const before = await page.evaluate(() => {
    const header = document.querySelector("header");
    const main = document.querySelector("main");
    return {
      headerTop: header!.getBoundingClientRect().top,
      mainScrollHeight: main!.scrollHeight,
      mainClientHeight: main!.clientHeight,
    };
  });
  expect(before.headerTop).toBeCloseTo(0, 0);
  expect(before.mainScrollHeight).toBeGreaterThan(before.mainClientHeight);

  // Scroll <main> well past the viewport and re-check the header.
  await page.evaluate(() => {
    const main = document.querySelector("main")!;
    main.scrollTop = 1500;
  });
  await page.waitForTimeout(150);

  const after = await page.evaluate(() => {
    const header = document.querySelector("header");
    const main = document.querySelector("main");
    return {
      headerTop: header!.getBoundingClientRect().top,
      headerBottom: header!.getBoundingClientRect().bottom,
      mainScrollTop: main!.scrollTop,
    };
  });
  expect(after.mainScrollTop).toBeGreaterThan(500);
  expect(after.headerTop).toBeCloseTo(0, 0);
  expect(after.headerBottom).toBeGreaterThan(40);

  // All toolbar controls must still be clickable / visible after the scroll.
  await expect(refresh).toBeVisible();
  await expect(addPunch).toBeVisible();
  await expect(page.getByRole("button", { name: /print/i })).toBeVisible();
});
