/**
 * End-to-end coverage for the per-row driver-suggestion dropdown only
 * surfacing drivers who actually have Connecteam (Driver-source) punches
 * this week — plus prior dispatcher decisions (driver_id_aliases for the
 * ids in play).
 *
 * Without this filter the dropdown lists the entire active roster, which
 * makes it trivial to mis-map a name to a test fixture ("AAA Driver
 * One") or a driver who didn't work that week.
 *
 * We exercise the BULK preview route (`/extract-customer-file`) because
 * it shares the same filtering logic as `/extract-new-customer` (both
 * narrow against punched-this-week unioned with prior aliases) and,
 * unlike the new-customer flow, doesn't require Gemini to drive end to
 * end. The companion unit test
 * `artifacts/api-server/src/lib/parsers/__tests__/candidatePool.test.ts`
 * pins the saved-alias-without-Connecteam-time case for the
 * new-customer route's pool builder specifically.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import * as XLSX from "xlsx";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the extract-suggestions-filter e2e test.",
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `e2e-sug-${Date.now().toString(36)}`;
const WEEK_START = "2031-08-03"; // Sunday
const WEEK_END = "2031-08-09"; // Saturday

// One TELD id is mapped to a seeded driver who HAS a Connecteam punch
// this week. A second TELD id is unmapped — its sampleName ("Bobson, B")
// would normally fuzzy-match BOTH the punched-this-week driver "Alice
// Bobson" AND the unpunched driver "Bob Bobson" (very similar tokens).
// Only the punched one should appear in the dropdown.
const MAPPED_TELD = `TELD${Math.floor(Math.random() * 9_000_000) + 1_000_000}`;
const UNMAPPED_TELD = `TELD${Math.floor(Math.random() * 9_000_000) + 1_000_000}`;
const DRIVER_PUNCHED = {
  kfiId: `91${Date.now().toString().slice(-8)}`.slice(0, 10),
  name: `Alice Bobson ${SUFFIX}`,
};
const DRIVER_UNPUNCHED = {
  kfiId: `92${Date.now().toString().slice(-8)}`.slice(0, 10),
  name: `Bob Bobson ${SUFFIX}`,
};
// Stand-in for the test-fixture drivers ("AAA Driver One", "BBB Driver
// Two") that the task explicitly mentions should disappear from the
// dropdown.
const DRIVER_FIXTURE = {
  kfiId: `93${Date.now().toString().slice(-8)}`.slice(0, 10),
  name: `AAA Driver Fixture ${SUFFIX}`,
};

const ADIENT_FILENAME = `Adient-${SUFFIX}.xlsx`;

// Build a minimal Adient-format XLSX:
//   - Employee Name block with the MAPPED TELD (so a real punch row is
//     produced and the parser doesn't bail with "0 punches").
//   - Transaction Apply Date header row (defines the column layout).
//   - A "Worked Shift Segment" row for the mapped driver.
//   - Employee Name block with the UNMAPPED TELD + a sample name —
//     this is what populates `unmappedIds[0]` with a `sampleName`, which
//     is what triggers the topMatches() call we care about.
function buildAdientXlsx(): Buffer {
  const rows: unknown[][] = [
    ["Employee Name", `Bobson, Alice (${MAPPED_TELD})`],
    [
      "Transaction Apply Date",
      "Transaction Type",
      "Hours",
      "Transaction Start Date/Time",
      "Transaction End Date/Time",
    ],
    [
      "2031-08-04",
      "Worked Shift Segment",
      8,
      "2031-08-04 07:00:00",
      "2031-08-04 15:00:00",
    ],
    ["Employee Name", `Bobson, B (${UNMAPPED_TELD})`],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START, WEEK_END],
  );
  for (const d of [DRIVER_PUNCHED, DRIVER_UNPUNCHED, DRIVER_FIXTURE]) {
    await pool.query(
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, 'Adient')
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer,
             is_archived = false`,
      [d.kfiId, d.name],
    );
  }
  // Map MAPPED_TELD → the punched driver via driver_id_aliases so the
  // Adient parser routes its punch row successfully. (EMBEDDED_MAPPING
  // is static, but the route loads merged aliases.)
  await pool.query(
    `INSERT INTO driver_id_aliases (external_id, kfi_id, customer)
       VALUES ($1, $2, 'Adient')
       ON CONFLICT (external_id) DO UPDATE
         SET kfi_id = EXCLUDED.kfi_id`,
    [MAPPED_TELD, DRIVER_PUNCHED.kfiId],
  );
  // Seed one Connecteam (Driver-source) punch for the punched driver so
  // the route's narrowing filter keeps them in the candidate pool. The
  // other two drivers have no Driver-source punch this week and must
  // therefore disappear from the suggestions.
  await pool.query(
    `INSERT INTO punches (week_start, kfi_id, source, date, clock_in, clock_out,
                          hours, is_manual)
       VALUES ($1, $2, 'Driver', $3, $4, $5, $6, false)`,
    [
      WEEK_START,
      DRIVER_PUNCHED.kfiId,
      "2031-08-04",
      "2031-08-04 7:00 AM",
      "2031-08-04 3:00 PM",
      "8.000",
    ],
  );
}

async function cleanup(): Promise<void> {
  const allKfi = [
    DRIVER_PUNCHED.kfiId,
    DRIVER_UNPUNCHED.kfiId,
    DRIVER_FIXTURE.kfiId,
  ];
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id = ANY($2::text[])`,
    [WEEK_START, allKfi],
  );
  await pool.query(
    `DELETE FROM ai_extract_samples
       WHERE week_start = $1 AND file_name = $2`,
    [WEEK_START, ADIENT_FILENAME],
  );
  await pool.query(
    `DELETE FROM customer_upload_attempts
       WHERE week_start = $1 AND last_file_name = $2`,
    [WEEK_START, ADIENT_FILENAME],
  );
  await pool.query(
    `DELETE FROM driver_id_aliases WHERE external_id = ANY($1::text[])`,
    [[MAPPED_TELD, UNMAPPED_TELD]],
  );
  await pool.query(
    `DELETE FROM drivers WHERE kfi_id = ANY($1::text[])`,
    [allKfi],
  );
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

// Skipped in CI: hits real Gemini via /extract-customer-file, which times out
// at Playwright's 10s actionTimeout and exhausts the AI proxy rate limit.
// Tracked by follow-up task #285 (add HTTP-level fake-Gemini mode).
(process.env.CI ? test.skip : test)("/extract-customer-file suggestion dropdown only offers drivers with Connecteam time this week", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file?force=1`,
    {
      multipart: {
        file: {
          name: ADIENT_FILENAME,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: buildAdientXlsx(),
        },
      },
    },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    unmappedIds: Array<{
      id: string;
      sampleName: string | null;
      suggestions: Array<{ kfiId: string; name: string; confidence: number }>;
    }>;
  };

  // The unmapped TELD must show up with the sample name + at least one
  // suggestion (otherwise the suggestion code path didn't run and the
  // test isn't proving anything).
  const unmapped = body.unmappedIds.find((u) => u.id === UNMAPPED_TELD);
  expect(unmapped, "expected the unmapped TELD to appear in unmappedIds").toBeDefined();
  expect(unmapped!.sampleName).toMatch(/Bobson/i);
  expect(unmapped!.suggestions.length).toBeGreaterThan(0);

  const suggestedIds = unmapped!.suggestions.map((s) => s.kfiId);
  // The punched driver is selectable…
  expect(suggestedIds).toContain(DRIVER_PUNCHED.kfiId);
  // …but the unpunched / fixture-shaped drivers must be filtered out,
  // even though "Bob Bobson" and "AAA Driver Fixture" would otherwise
  // fuzzy-rank against "Bobson, B".
  expect(suggestedIds).not.toContain(DRIVER_UNPUNCHED.kfiId);
  expect(suggestedIds).not.toContain(DRIVER_FIXTURE.kfiId);
});
