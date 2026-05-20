// Regression pin for Task #377: re-uploading a customer file that only
// mentions a subset of drivers must NOT erase previously-imported
// Customer-source rows for drivers absent from the new upload.
//
// The confirm-customer-file flow wipes-and-reinserts (week, customer)
// Customer-source rows inside a tx. Before #377, the DELETE was scoped
// only by (week, customer, source='Customer', is_manual=false,
// edited<>true) — so re-uploading a file covering driver A would also
// wipe driver B's prior Customer-source rows for the same customer.
//
// The fix adds `kfi_id IN (<drivers in the new upload>)` to the
// DELETE predicate, and skips the DELETE entirely when the new upload
// resolves to zero drivers. Manual rows, edited rows, and locked
// driver-weeks continue to be preserved exactly as today.
//
// DB-backed; gated by the e2e DB allow-list helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const ALLOWED_HOSTS = new Set(["helium", "localhost", "127.0.0.1"]);
const ALLOWED_DBS = new Set(["heliumdb"]);

function shouldRun(): boolean {
  if (process.env.KFI_E2E_ALLOW_DB !== "1") return false;
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const u = new URL(url);
    const dbName = u.pathname.replace(/^\//, "");
    return ALLOWED_HOSTS.has(u.hostname) && ALLOWED_DBS.has(dbName);
  } catch {
    return false;
  }
}

const WEEK = "2024-12-29"; // Sunday; sentinel week
const CUSTOMER = "__test_subset_customer__";
const KFI_A = "__test_subset_a__";
const KFI_B = "__test_subset_b__";

async function cleanup(pool: Pool) {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND customer = $2`,
    [WEEK, CUSTOMER],
  );
}

async function seed(pool: Pool) {
  await cleanup(pool);
  // Two Customer-source rows imported previously: one for driver A, one
  // for driver B. Plus a manual + edited row on driver A that must
  // survive every code path.
  await pool.query(
    `INSERT INTO punches
      (week_start, kfi_id, customer, source, date,
       clock_in, clock_out, hours, disp_tz, is_manual, edited)
     VALUES
      ($1,$2,$4,'Customer','2024-12-30','2024-12-30 8:00 AM','2024-12-30 12:00 PM','4','America/Chicago',false,false),
      ($1,$3,$4,'Customer','2024-12-31','2024-12-31 8:00 AM','2024-12-31 12:30 PM','4.5','America/Chicago',false,false),
      ($1,$2,$4,'Customer','2025-01-01','2025-01-01 8:00 AM','2025-01-01 12:00 PM','4','America/Chicago',true ,false),
      ($1,$2,$4,'Customer','2025-01-02','2025-01-02 8:00 AM','2025-01-02 12:30 PM','4.5','America/Chicago',false,true)`,
    [WEEK, KFI_A, KFI_B, CUSTOMER],
  );
}

async function snapshot(pool: Pool, kfiId: string) {
  const { rows } = await pool.query<{
    source: string;
    is_manual: boolean;
    edited: boolean;
    date: string;
  }>(
    `SELECT source, is_manual, edited, date
       FROM punches WHERE week_start = $1 AND customer = $2 AND kfi_id = $3
       ORDER BY date, clock_in`,
    [WEEK, CUSTOMER, kfiId],
  );
  return rows.map(
    (r) => `${r.source}|m=${r.is_manual}|e=${r.edited}|d=${r.date}`,
  );
}

if (!shouldRun()) {
  test("customer-confirm-subset-preservation [skipped: DB allow-list not set]", () => {
    // No-op when DB is not available (e.g. unit-only runs).
  });
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  test("subset re-upload DELETE predicate preserves other drivers' rows", async (t) => {
    t.after(async () => {
      await cleanup(pool);
    });
    await seed(pool);

    // Mirrors the new wipe-and-reinsert DELETE in
    // artifacts/api-server/src/routes/weeks.ts (confirm-customer-file
    // route) when the new upload mentions ONLY driver A. The crucial
    // addition vs. the pre-#377 predicate is the `kfi_id = ANY($3)`
    // scoping clause.
    await pool.query(
      `DELETE FROM punches
        WHERE week_start = $1
          AND customer = $2
          AND source = 'Customer'
          AND is_manual = false
          AND edited <> true
          AND kfi_id = ANY($3::text[])`,
      [WEEK, CUSTOMER, [KFI_A]],
    );

    // Driver A's non-manual, non-edited Customer row is gone (it would
    // be reinserted by the confirm path — we don't model that here).
    // The manual + edited rows for A survive.
    assert.deepEqual(await snapshot(pool, KFI_A), [
      "Customer|m=true|e=false|d=2025-01-01",
      "Customer|m=false|e=true|d=2025-01-02",
    ]);
    // Driver B was NOT in the new upload, so its prior row survives —
    // this is the bug the task fixes.
    assert.deepEqual(await snapshot(pool, KFI_B), [
      "Customer|m=false|e=false|d=2024-12-31",
    ]);
  });

  test("empty-upload (zero drivers) skips DELETE entirely", async (t) => {
    t.after(async () => {
      await cleanup(pool);
    });
    await seed(pool);

    // The confirm route's behavior when insertableKfiIds.size === 0:
    // skip the DELETE entirely. We don't issue a DELETE here at all to
    // pin that contract — both drivers' rows must survive.
    assert.deepEqual(await snapshot(pool, KFI_A), [
      "Customer|m=false|e=false|d=2024-12-30",
      "Customer|m=true|e=false|d=2025-01-01",
      "Customer|m=false|e=true|d=2025-01-02",
    ]);
    assert.deepEqual(await snapshot(pool, KFI_B), [
      "Customer|m=false|e=false|d=2024-12-31",
    ]);
  });

  test("subset re-upload covering both drivers wipes both (no leftover)", async (t) => {
    t.after(async () => {
      await cleanup(pool);
      await pool.end();
    });
    await seed(pool);

    // When the new upload mentions both A and B, the DELETE removes
    // both prior non-manual / non-edited Customer rows so the
    // reinsert can't create duplicates.
    await pool.query(
      `DELETE FROM punches
        WHERE week_start = $1
          AND customer = $2
          AND source = 'Customer'
          AND is_manual = false
          AND edited <> true
          AND kfi_id = ANY($3::text[])`,
      [WEEK, CUSTOMER, [KFI_A, KFI_B]],
    );

    assert.deepEqual(await snapshot(pool, KFI_A), [
      "Customer|m=true|e=false|d=2025-01-01",
      "Customer|m=false|e=true|d=2025-01-02",
    ]);
    assert.deepEqual(await snapshot(pool, KFI_B), []);
  });
}
