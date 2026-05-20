/**
 * End-to-end coverage for Task #163: the all-reviewed celebration plays a
 * short chime when the week transitions to fully-reviewed, gated on a
 * per-user "celebration sound" preference. This spec covers the muted path:
 * when the preference is off the splash still appears but no AudioContext
 * is created.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";


const pool = createE2EPool();

const WEEK_START = "2031-06-01";
const WEEK_END = "2031-06-07";
const SUFFIX = `e2e-cs-${Date.now().toString(36)}`;
const DRIVERS = [
  { kfiId: `KFI-CS1-${SUFFIX}`, name: "AAA Chime One", customer: "Adient" },
  { kfiId: `KFI-CS2-${SUFFIX}`, name: "BBB Chime Two", customer: "Adient" },
] as const;

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
       ON CONFLICT (start_date) DO NOTHING`,
      [WEEK_START, WEEK_END],
    );
    for (const d of DRIVERS) {
      await client.query(
        `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
         ON CONFLICT (kfi_id) DO UPDATE
           SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
        [d.kfiId, d.name, d.customer],
      );
      await client.query(
        `INSERT INTO punches
           (week_start, kfi_id, customer, source, date,
            clock_in, clock_out, hours, is_manual)
         VALUES ($1::date, $2, $3, 'Driver', $4,
                 $5, $6, 4.0, true)`,
        [
          WEEK_START,
          d.kfiId,
          d.customer,
          WEEK_START,
          `${WEEK_START} 8:00 AM`,
          `${WEEK_START} 12:00 PM`,
        ],
      );
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
  const ids = DRIVERS.map((d) => d.kfiId);
  await pool.query(`DELETE FROM reviewed_drivers WHERE week_start = $1`, [
    WEEK_START,
  ]);
  await pool.query(`DELETE FROM punches WHERE week_start = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`, [ids]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("celebration sound preference: muted path shows splash but does not construct an AudioContext", async ({
  page,
}) => {
  // Disable auto-advance (so toggling current driver doesn't navigate) and
  // turn the celebration sound preference OFF before any app code runs.
  // Then install AudioContext spies that count constructor calls so we can
  // assert no chime was attempted.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("kfi-ot:auto-advance-reviewed:v1", "0");
      window.localStorage.setItem("kfi-ot:celebration-sound:v1", "0");
    } catch {
      /* ignore */
    }
    const w = window as unknown as {
      __audioCtxCount: number;
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    w.__audioCtxCount = 0;
    const wrap = (Orig?: typeof AudioContext) => {
      if (!Orig) return undefined;
      // Proxy preserves prototype/instanceof so any code that constructs an
      // AudioContext bumps the counter.
      return new Proxy(Orig, {
        construct(target, args, newTarget) {
          w.__audioCtxCount += 1;
          return Reflect.construct(target, args, newTarget);
        },
      });
    };
    const wrappedStd = wrap(w.AudioContext);
    if (wrappedStd) w.AudioContext = wrappedStd;
    const wrappedWebkit = wrap(w.webkitAudioContext);
    if (wrappedWebkit) w.webkitAudioContext = wrappedWebkit;
  });

  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}/drivers/${DRIVERS[0].kfiId}`);
  await expect(
    page.getByRole("heading", { name: DRIVERS[0].name }),
  ).toBeVisible();
  await expect(page.getByTestId("drivers-sidebar")).toBeVisible();

  // Verify the toggle is rendered next to auto-advance and reflects the
  // muted preference we seeded.
  await page.keyboard.press("?");
  const soundCheckbox = page.getByTestId("checkbox-celebration-sound");
  await expect(soundCheckbox).toBeVisible();
  await expect(soundCheckbox).not.toBeChecked();
  await expect(page.getByTestId("checkbox-auto-advance")).toBeVisible();
  // Close the dialog so the celebration is not blocked by it.
  await page.keyboard.press("Escape");

  const pill = page.getByTestId("pill-reviewed-progress");
  const bubble1 = page.getByTestId(`sidebar-bubble-${DRIVERS[0].kfiId}`);
  const bubble2 = page.getByTestId(`sidebar-bubble-${DRIVERS[1].kfiId}`);
  const splash = page.getByTestId("all-reviewed-splash");

  await expect(pill).toHaveText("0 / 2 reviewed");
  await expect(splash).toHaveCount(0);

  await bubble1.click();
  await expect(pill).toHaveText("1 / 2 reviewed");
  await expect(splash).toHaveCount(0);

  // Toggling the last unreviewed driver fires the celebration. The splash
  // must appear, but with the sound preference off no AudioContext should
  // be constructed.
  await bubble2.click();
  await expect(pill).toHaveText("All reviewed");
  await expect(splash).toBeVisible();

  // Give the chime code a beat to (incorrectly) fire if it were going to.
  await page.waitForTimeout(250);
  const count = await page.evaluate(
    () =>
      (window as unknown as { __audioCtxCount: number }).__audioCtxCount ?? 0,
  );
  expect(count).toBe(0);
});
