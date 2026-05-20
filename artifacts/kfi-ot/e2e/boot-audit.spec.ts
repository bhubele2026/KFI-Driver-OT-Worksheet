/**
 * Task #402 — republish safety audit smoke test.
 *
 * The API server is already running for the e2e suite. After a clean
 * boot, every audited routine must have written at least one row to
 * `data_mutation_audit` keyed to its name. This spec just confirms
 * those rows are present and that, for a clean dev DB, none of them
 * carry a `refused` outcome (the bulk-delete guard would only be
 * tripped if a routine actually tried to delete in anger).
 *
 * It also signs in as an admin and verifies /admin/boot-audit renders
 * the most-recent rows with the expected routine names visible.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const EXPECTED_ROUTINES = [
  "repairBogusObjectCustomers",
  "seedDriverPayrollProfiles",
  "deleteLegacyParserSchemaRows",
] as const;

test.afterAll(async () => {
  await pool.end();
});

test("data_mutation_audit captures every audited boot routine", async () => {
  // The API server has been running since the suite started; if a
  // boot routine fired even once, its row is here. This loop is the
  // assertion contract from the task spec ("a `noop` row appears for
  // each boot routine when there's nothing to fix") — we accept any
  // outcome other than `refused`/`error` for a clean dev boot.
  for (const routine of EXPECTED_ROUTINES) {
    const { rows } = await pool.query<{
      outcome: string;
      rows_affected: number;
    }>(
      `SELECT outcome, rows_affected
         FROM data_mutation_audit
        WHERE routine = $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [routine],
    );
    expect(
      rows.length,
      `expected at least one boot-audit row for routine="${routine}"`,
    ).toBeGreaterThan(0);
    expect(
      ["noop", "ok"],
      `routine="${routine}" outcome should be benign on a clean dev boot`,
    ).toContain(rows[0]!.outcome);
  }
});

test("/admin/boot-audit lists the latest boot routine rows", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  await page.goto("/admin/boot-audit");
  await expect(
    page.getByRole("heading", { name: "Boot-time audit" }),
  ).toBeVisible();

  // Pull the very latest row id for each expected routine so we can
  // assert its testid is rendered, not just that the routine name
  // appears somewhere on the page.
  for (const routine of EXPECTED_ROUTINES) {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM data_mutation_audit
        WHERE routine = $1
        ORDER BY started_at DESC LIMIT 1`,
      [routine],
    );
    if (rows.length === 0) continue;
    await expect(
      page.getByTestId(`row-boot-audit-${rows[0]!.id}`),
    ).toBeVisible();
  }
});
