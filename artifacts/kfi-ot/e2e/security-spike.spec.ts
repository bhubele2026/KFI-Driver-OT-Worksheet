/**
 * End-to-end coverage for the admin Security panel's spike-to-suspect flow on
 * the /admin/users page (artifacts/kfi-ot/src/pages/admin-users.tsx),
 * backed by `/auth/rate-limit-events/top-offenders` in
 * artifacts/api-server/src/routes/auth.ts.
 *
 * Verifies:
 *   - Seeds `rate_limit_events` rows across two UTC days for distinct
 *     (limiter, key) pairs under a unique e2e-only limiter name.
 *   - Signs in as admin, opens /admin/users, clicks the chart bar for
 *     today's UTC day, and asserts the "Top offenders on …" callout lists
 *     the seeded entries in count-descending order.
 *   - Seeds a live `rate_limit_buckets` row for the top offender so the
 *     inline "Clear" button is rendered, then clicks it and asserts that
 *     `DELETE /auth/rate-limit-buckets/:name/:key` removes the row from
 *     the active rate-limit buckets table above the chart.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the security-spike e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = Date.now().toString(36);
const LIMITER = `e2e-spike-${SUFFIX}`;
const KEY_TOP = `e2e-${SUFFIX}-key-top`;
const KEY_MID = `e2e-${SUFFIX}-key-mid`;
const KEY_PREV = `e2e-${SUFFIX}-key-prev`;

// Anchor the seed to UTC day boundaries so the chart bucket math
// (date_trunc('day', blocked_at AT TIME ZONE 'UTC')) lands deterministically.
const TODAY_UTC_MS = Math.floor(Date.now() / 86_400_000) * 86_400_000;
// Pick noon UTC so a slight clock skew never pushes the row across the
// day boundary.
const TODAY_NOON = new Date(TODAY_UTC_MS + 12 * 3_600_000);
const YESTERDAY_NOON = new Date(
  TODAY_UTC_MS - 86_400_000 + 12 * 3_600_000,
);
const TODAY_ISO_DAY = TODAY_NOON.toISOString().slice(0, 10);

async function seed(): Promise<void> {
  // (LIMITER, KEY_TOP) — 5 events today
  // (LIMITER, KEY_MID) — 3 events today
  // (LIMITER, KEY_PREV) — 2 events yesterday (the "two UTC days" requirement)
  const inserts: Array<{ key: string; at: Date; n: number }> = [
    { key: KEY_TOP, at: TODAY_NOON, n: 5 },
    { key: KEY_MID, at: TODAY_NOON, n: 3 },
    { key: KEY_PREV, at: YESTERDAY_NOON, n: 2 },
  ];
  for (const row of inserts) {
    for (let i = 0; i < row.n; i++) {
      await pool.query(
        `INSERT INTO rate_limit_events (name, key, blocked_at, expired_at)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz + INTERVAL '1 hour')`,
        [LIMITER, row.key, new Date(row.at.getTime() + i * 1000).toISOString()],
      );
    }
  }
  // Live bucket for the top offender so the inline Clear button is rendered.
  await pool.query(
    `INSERT INTO rate_limit_buckets (name, key, count, reset_at)
     VALUES ($1, $2, 99, NOW() + INTERVAL '1 hour')
     ON CONFLICT (name, key) DO UPDATE
       SET count = EXCLUDED.count, reset_at = EXCLUDED.reset_at`,
    [LIMITER, KEY_TOP],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM rate_limit_events WHERE name = $1`, [LIMITER]);
  await pool.query(`DELETE FROM rate_limit_buckets WHERE name = $1`, [LIMITER]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

// Quarantined: flaky chart-bar click (task #150). See follow-up #193.
test.fixme("admin clicks a chart bar, sees top offenders, and clears a bucket", async ({
  page,
}) => {
  // Sign in via the dev auth bypass.
  await signInAsDispatcher(page);

  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "Admin · Users" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Security activity")).toBeVisible({
    timeout: 15_000,
  });

  // Poll the timeseries endpoint directly until our seeded LIMITER shows up.
  // The chart's bar-render heuristic depends on the data already being
  // present; otherwise the rightmost-bar pick targets an empty day. We poll
  // from page context (so cookies attach) rather than waitForResponse, which
  // can't be retried if the very first React-Query response races the seed.
  await page.waitForFunction(
    async (limiterName) => {
      const res = await fetch(
        "/api/auth/rate-limit-events/timeseries?days=7",
        { credentials: "include" },
      );
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as
        | Array<{ name?: string; count?: number }>
        | null;
      return Array.isArray(body) && body.some((p) => p.name === limiterName);
    },
    LIMITER,
    { timeout: 15_000 },
  );

  // The seeded live bucket should be listed in the Active rate-limit buckets
  // table above the chart. The same KEY_TOP also appears in the Recent
  // lockouts table further down (which has no Clear button), so we
  // disambiguate by requiring an inline Clear button on the row.
  const activeBucketRow = page
    .locator("tr", { hasText: KEY_TOP })
    .filter({ has: page.getByRole("button", { name: /^Clear$/ }) });
  await expect(activeBucketRow).toBeVisible({ timeout: 10_000 });

  // Wait for the chart to render (timeseries query resolved + non-empty).
  // Days with count=0 render as <path d=""> (zero-area), so wait for at
  // least one rect with a non-empty path data attribute.
  const nonEmptyBars = page.locator(
    '.recharts-bar-rectangle path:not([d=""])',
  );
  await expect(nonEmptyBars.first()).toBeVisible({ timeout: 10_000 });

  // Locate today's bar by bounding box: today is the rightmost data point in
  // the 7-day window, and our seeded counts (5+3=8 today vs 2 yesterday and
  // zeros elsewhere) make the today column the tallest visible rect for any
  // limiter. We pick the bar whose bounding box has both the largest x AND
  // a non-trivial height — that is, the rightmost non-zero bar.
  await selectDayBar(page, TODAY_ISO_DAY);

  // The selected-day banner confirms which day got picked.
  const banner = page.locator("text=/Showing lockouts active on/");
  await expect(banner).toBeVisible();
  const todayLabel = formatBannerDate(TODAY_ISO_DAY);
  await expect(banner).toContainText(todayLabel);

  // Top-offenders callout is rendered for the selected day.
  const callout = page
    .locator("div", { hasText: /^Top offenders on/ })
    .filter({ hasText: KEY_TOP });
  await expect(callout).toBeVisible();

  // Pull the offender rows in render order and assert KEY_TOP precedes
  // KEY_MID (5 > 3 → count-descending order). Yesterday's KEY_PREV must
  // not be present in this day's callout.
  const offenderItems = callout.locator("ol > li");
  const rowsText = (await offenderItems.allTextContents()).join("\n");
  expect(rowsText).toContain(KEY_TOP);
  expect(rowsText).toContain(KEY_MID);
  expect(rowsText).not.toContain(KEY_PREV);

  const topRow = offenderItems.filter({ hasText: KEY_TOP });
  const midRow = offenderItems.filter({ hasText: KEY_MID });
  const topBox = await topRow.boundingBox();
  const midBox = await midRow.boundingBox();
  expect(topBox && midBox).toBeTruthy();
  expect(topBox!.y).toBeLessThan(midBox!.y);

  // The top offender has a live bucket → Clear button is rendered inline.
  const clearBtn = topRow.getByRole("button", { name: /Clear/ });
  await expect(clearBtn).toBeVisible();

  // Verify the DELETE request fires when we click Clear.
  const deleteResp = page.waitForResponse(
    (r) =>
      r.request().method() === "DELETE" &&
      r.url().includes(
        `/api/auth/rate-limit-buckets/${encodeURIComponent(LIMITER)}/${encodeURIComponent(KEY_TOP)}`,
      ),
  );
  await clearBtn.click();
  const resp = await deleteResp;
  expect(resp.status()).toBe(204);

  // The active-buckets table should refetch and the seeded row should
  // disappear (cleared bucket → deleted by clearBucket() backend).
  await expect(activeBucketRow).toHaveCount(0, { timeout: 5_000 });
});

/**
 * Click the chart bar that corresponds to `targetDay` (UTC `YYYY-MM-DD`).
 * Strategy: collect every rendered bar rect's bounding box, then click the
 * rightmost non-zero-height rect — the chart is sorted ascending by day so
 * the rightmost band is "today". After the click, verify the banner shows
 * the expected day; if not, fall back to scanning bars right-to-left.
 */
async function selectDayBar(
  page: import("@playwright/test").Page,
  targetDay: string,
): Promise<void> {
  const expectedLabel = formatBannerDate(targetDay);
  const bars = page.locator('.recharts-bar-rectangle path:not([d=""])');
  const total = await bars.count();
  const candidates: Array<{ idx: number; x: number; height: number }> = [];
  for (let i = 0; i < total; i++) {
    const box = await bars.nth(i).boundingBox();
    if (box && box.height > 1) {
      candidates.push({ idx: i, x: box.x, height: box.height });
    }
  }
  // Sort right-to-left so today's bar is tried first.
  candidates.sort((a, b) => b.x - a.x);
  for (const c of candidates) {
    await bars.nth(c.idx).click({ force: true });
    const banner = page.locator("text=/Showing lockouts active on/");
    try {
      await expect(banner).toContainText(expectedLabel, { timeout: 1_500 });
      return;
    } catch {
      // Wrong day — try the next bar.
    }
  }
  throw new Error(
    `could not click a chart bar that selected ${targetDay} (${expectedLabel})`,
  );
}

/**
 * Mirror the page's banner formatter:
 *   format(parseISO(day), "MMM d, yyyy")
 * We avoid pulling date-fns into the spec by formatting via Intl in UTC.
 */
function formatBannerDate(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  // e.g. "May 6, 2026"
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}
