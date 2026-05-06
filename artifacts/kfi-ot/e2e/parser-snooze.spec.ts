/**
 * End-to-end coverage for the parser-promotion snooze flow.
 *
 * Surfaces touched:
 *   - The dispatcher week dashboard's "Parser candidate" banner inside
 *     `artifacts/kfi-ot/src/components/customer-upload-panel.tsx`, including
 *     the per-candidate "Don't suggest" dropdown that POSTs to
 *     `/api/parser-promotion-snoozes`.
 *   - The admin `/admin/parser-snoozes` page
 *     (`artifacts/kfi-ot/src/pages/admin-parser-snoozes.tsx`) listing active
 *     snoozes and supporting "Resume suggestions".
 *   - The `customer-uploads` aggregation in
 *     `artifacts/api-server/src/routes/weeks.ts` that suppresses
 *     `promotionCandidate` for active snoozes and re-surfaces them when
 *     `snoozedUntil` is in the past.
 *
 * Two cases:
 *   1. Snooze-forever: seed an AI-imported customer into promotion-candidate
 *      territory (3 distinct AI-import weeks), confirm the banner shows the
 *      candidate, snooze it from the banner, confirm it disappears from the
 *      banner and appears under /admin/parser-snoozes, then resume it and
 *      confirm the banner re-surfaces.
 *   2. Time-bounded snooze (4 weeks): snooze the same candidate from the
 *      banner, then directly age its `snoozed_until` into the past and
 *      confirm the banner re-surfaces (proving the customer-uploads filter
 *      treats expired snoozes as inactive).
 */
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the parser-snooze e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-ps-${Date.now().toString(36)}`;
// Unique customer name so the suggestion is guaranteed not to be in
// KNOWN_CUSTOMERS — it must come through the aiOnly branch of the
// customer-uploads aggregation.
const CUSTOMER = `ZZZ-Snoozeable-${SUFFIX}`;

// Pick three Mondays well in the future so we don't collide with real data.
// The dashboard renders the most recent of these; the other two only need
// to bump aiImportWeekCount past the >= 3 promotion threshold.
const VIEW_WEEK = "2031-05-05";
const HISTORY_WEEKS = ["2031-04-21", "2031-04-28"];
const WEEK_END_BY_START: Record<string, string> = {
  "2031-04-21": "2031-04-27",
  "2031-04-28": "2031-05-04",
  "2031-05-05": "2031-05-11",
};

async function seed(): Promise<void> {
  for (const ws of [...HISTORY_WEEKS, VIEW_WEEK]) {
    await pool.query(
      `INSERT INTO weeks (start_date, end_date)
       VALUES ($1::date, $2::date)
       ON CONFLICT (start_date) DO NOTHING`,
      [ws, WEEK_END_BY_START[ws]],
    );
    await pool.query(
      `INSERT INTO customer_upload_attempts
         (week_start, customer, last_attempt_at, last_success_at,
          last_file_name, last_error, last_source, last_unmapped_ids)
       VALUES ($1::date, $2, NOW(), NOW(),
               $3, NULL, 'ai', ARRAY[]::text[])
       ON CONFLICT (week_start, customer) DO UPDATE
         SET last_attempt_at = EXCLUDED.last_attempt_at,
             last_success_at = EXCLUDED.last_success_at,
             last_file_name  = EXCLUDED.last_file_name,
             last_error      = EXCLUDED.last_error,
             last_source     = EXCLUDED.last_source,
             last_unmapped_ids = EXCLUDED.last_unmapped_ids`,
      [ws, CUSTOMER, `${CUSTOMER}-${ws}.pdf`],
    );
  }
}

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE customer = $1`,
    [CUSTOMER],
  );
  await pool.query(
    `DELETE FROM parser_promotion_snoozes WHERE lower(customer) = lower($1)`,
    [CUSTOMER],
  );
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterEach(async () => {
  // Each test snoozes the candidate; clear the snooze so the next test
  // starts from the same "candidate visible" baseline.
  await pool.query(
    `DELETE FROM parser_promotion_snoozes WHERE lower(customer) = lower($1)`,
    [CUSTOMER],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function gotoWeek(page: Page): Promise<void> {
  // Hit "/" first so AuthGate fires the dev-bypass and the dispatcher is
  // signed in as an admin before we reach a route the panel lives on.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.goto(`/weeks/${VIEW_WEEK}`);
  // The page renders the dashboard once the week summary query resolves.
  await page.waitForLoadState("networkidle");
}

function bannerCandidate(page: Page) {
  // The banner renders each candidate as an <li> containing the customer
  // name in a <span class="font-medium">. Scope to the amber banner so we
  // don't accidentally match the per-row `AI · N weeks` badge below.
  return page
    .locator('ul li', { hasText: CUSTOMER })
    .filter({ has: page.getByRole("button", { name: /Don't suggest/ }) });
}

test("admin can snooze a parser-candidate forever and resume it", async ({
  page,
}) => {
  await gotoWeek(page);

  // 1. The seeded candidate appears in the amber banner with a "Don't
  //    suggest" button.
  await expect(bannerCandidate(page)).toBeVisible();

  // 2. Open the dropdown and pick "Forever (until lifted)".
  await bannerCandidate(page)
    .getByRole("button", { name: /Don't suggest/ })
    .click();
  await page
    .getByRole("menuitem", { name: "Forever (until lifted)" })
    .click();

  // 3. The banner candidate disappears (queries are invalidated on
  //    success). If the banner has no other candidates it disappears
  //    entirely; in either case the row for our customer is gone.
  await expect(bannerCandidate(page)).toHaveCount(0);

  // 4. Navigate to /admin/parser-snoozes and confirm the customer is
  //    listed with a "Resume suggestions" button.
  await page.goto("/admin/parser-snoozes");
  await expect(
    page.getByRole("heading", { name: "Admin · Parser-promotion snoozes" }),
  ).toBeVisible();
  const row = page.locator("tr", { hasText: CUSTOMER });
  await expect(row).toBeVisible();
  await expect(row.getByText("Forever (until lifted)")).toBeVisible();

  // 5. Click "Resume suggestions" — the row should disappear from the
  //    snoozes table.
  await row.getByRole("button", { name: /Resume suggestions/ }).click();
  await expect(page.locator("tr", { hasText: CUSTOMER })).toHaveCount(0);

  // 6. Back on the week dashboard, the candidate is suggested again.
  await page.goto(`/weeks/${VIEW_WEEK}`);
  await page.waitForLoadState("networkidle");
  await expect(bannerCandidate(page)).toBeVisible();
});

test("a time-bounded snooze auto-expires once snoozedUntil is in the past", async ({
  page,
}) => {
  await gotoWeek(page);
  await expect(bannerCandidate(page)).toBeVisible();

  // 1. Snooze for 4 weeks via the banner dropdown.
  await bannerCandidate(page)
    .getByRole("button", { name: /Don't suggest/ })
    .click();
  await page.getByRole("menuitem", { name: "4 weeks" }).click();
  await expect(bannerCandidate(page)).toHaveCount(0);

  // 2. Confirm the row exists with a future snoozed_until.
  const before = await pool.query<{ snoozed_until: Date | null }>(
    `SELECT snoozed_until FROM parser_promotion_snoozes
       WHERE lower(customer) = lower($1)`,
    [CUSTOMER],
  );
  expect(before.rowCount).toBe(1);
  expect(before.rows[0].snoozed_until).not.toBeNull();
  expect(before.rows[0].snoozed_until!.getTime()).toBeGreaterThan(Date.now());

  // 3. Age the snooze into the past so the customer-uploads filter
  //    treats it as inactive on the next request.
  await pool.query(
    `UPDATE parser_promotion_snoozes
        SET snoozed_until = NOW() - INTERVAL '1 day'
      WHERE lower(customer) = lower($1)`,
    [CUSTOMER],
  );

  // 4. Reload the dashboard — the banner candidate re-surfaces because
  //    the snooze is no longer active.
  await page.goto(`/weeks/${VIEW_WEEK}`);
  await page.waitForLoadState("networkidle");
  await expect(bannerCandidate(page)).toBeVisible();
});
