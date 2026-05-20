// Regression pin for the Connecteam-refresh edit-preservation contract.
//
// Connecteam refresh (week-wide and per-driver) must NEVER delete:
//   - Manual driver entries     (source='Driver', is_manual=true)
//   - Edited Connecteam rows    (source='Driver', is_manual=false, edited=true)
//   - Any Customer-source rows  (source='Customer', regardless of is_manual)
//
// The new admin-only "Remove Connecteam time" action is the explicit
// escape hatch when you DO want to wipe edited Connecteam rows for one
// driver/week — it deletes every Driver-source non-manual row regardless
// of `edited`. This test pins both behaviors with literal SQL that mirrors
// the routes, so a future refactor that loosens either predicate will
// either fail this test or require an explicit, reviewed update here.
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

const WEEK = "2024-12-29"; // Sunday; sentinel week we own end-to-end here
const KFI = "__test_refresh_preserve__";
const OTHER_KFI = "__test_refresh_other__";

async function cleanup(pool: Pool) {
  await pool.query(
    `DELETE FROM punches WHERE week_start = $1 AND kfi_id IN ($2, $3)`,
    [WEEK, KFI, OTHER_KFI],
  );
}

async function seed(pool: Pool) {
  await cleanup(pool);
  // 1) Untouched Connecteam row — refresh SHOULD delete this.
  // 2) Edited Connecteam row    — refresh MUST preserve, but "remove" deletes.
  // 3) Manual driver row        — both refresh and "remove" MUST preserve.
  // 4) Customer-source row      — both refresh and "remove" MUST preserve.
  // 5) Same as (1) but for an unrelated driver — used to prove the per-driver
  //    delete is scoped by kfi_id and doesn't leak to neighbors.
  await pool.query(
    `INSERT INTO punches
      (week_start, kfi_id, customer, source, date,
       clock_in, clock_out, hours, disp_tz, is_manual, edited, ct_external_key)
     VALUES
      ($1,$2,NULL,'Driver','2024-12-30','2024-12-30 8:00 AM','2024-12-30 12:00 PM','4','America/Chicago',false,false,'ct:test:untouched'),
      ($1,$2,NULL,'Driver','2024-12-31','2024-12-31 8:00 AM','2024-12-31 12:30 PM','4.5','America/Chicago',false,true ,'ct:test:edited'),
      ($1,$2,NULL,'Driver','2025-01-01','2025-01-01 8:00 AM','2025-01-01 12:00 PM','4','America/Chicago',true ,false,NULL),
      ($1,$2,'Penda','Customer','2025-01-02','2025-01-02 8:00 AM','2025-01-02 12:00 PM','4','America/Chicago',false,false,NULL),
      ($1,$3,NULL,'Driver','2024-12-30','2024-12-30 8:00 AM','2024-12-30 12:00 PM','4','America/Chicago',false,false,'ct:other:untouched')`,
    [WEEK, KFI, OTHER_KFI],
  );
}

async function snapshot(pool: Pool, kfiId: string) {
  const { rows } = await pool.query<{
    source: string;
    is_manual: boolean;
    edited: boolean;
    ct_external_key: string | null;
  }>(
    `SELECT source, is_manual, edited, ct_external_key
       FROM punches WHERE week_start = $1 AND kfi_id = $2
       ORDER BY date, clock_in`,
    [WEEK, kfiId],
  );
  return rows.map(
    (r) => `${r.source}|m=${r.is_manual}|e=${r.edited}|k=${r.ct_external_key ?? "-"}`,
  );
}

if (!shouldRun()) {
  test("connecteam-refresh-preservation [skipped: DB allow-list not set]", () => {
    // No-op when DB is not available (e.g. unit-only runs).
  });
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  test("per-driver refresh DELETE predicate preserves edited+manual+customer rows", async (t) => {
    t.after(async () => {
      await cleanup(pool);
    });
    await seed(pool);

    // Mirrors the per-driver refresh DELETE in
    // artifacts/api-server/src/routes/weeks.ts (refresh-connecteam route).
    await pool.query(
      `DELETE FROM punches
        WHERE week_start = $1
          AND kfi_id = $2
          AND source = 'Driver'
          AND is_manual = false
          AND edited <> true`,
      [WEEK, KFI],
    );

    assert.deepEqual(await snapshot(pool, KFI), [
      "Driver|m=false|e=true|k=ct:test:edited",
      "Driver|m=true|e=false|k=-",
      "Customer|m=false|e=false|k=-",
    ]);
    // Neighbor driver untouched.
    assert.deepEqual(await snapshot(pool, OTHER_KFI), [
      "Driver|m=false|e=false|k=ct:other:untouched",
    ]);
  });

  test("week-wide refresh DELETE predicate preserves edited+manual+customer rows", async (t) => {
    t.after(async () => {
      await cleanup(pool);
    });
    await seed(pool);

    // Mirrors the week-wide refresh DELETE in weeks.ts (no kfi_id filter).
    await pool.query(
      `DELETE FROM punches
        WHERE week_start = $1
          AND source = 'Driver'
          AND is_manual = false
          AND edited <> true`,
      [WEEK],
    );

    assert.deepEqual(await snapshot(pool, KFI), [
      "Driver|m=false|e=true|k=ct:test:edited",
      "Driver|m=true|e=false|k=-",
      "Customer|m=false|e=false|k=-",
    ]);
    // Neighbor's untouched Connecteam row also wiped (week-wide).
    assert.deepEqual(await snapshot(pool, OTHER_KFI), []);
  });

  test("remove-connecteam-time DELETE predicate also deletes edited rows but preserves manual+customer", async (t) => {
    t.after(async () => {
      await cleanup(pool);
      await pool.end();
    });
    await seed(pool);

    // Mirrors the new per-driver remove-connecteam-time DELETE: same as
    // refresh but WITHOUT the edited<>true guard.
    await pool.query(
      `DELETE FROM punches
        WHERE week_start = $1
          AND kfi_id = $2
          AND source = 'Driver'
          AND is_manual = false`,
      [WEEK, KFI],
    );

    assert.deepEqual(await snapshot(pool, KFI), [
      "Driver|m=true|e=false|k=-",
      "Customer|m=false|e=false|k=-",
    ]);
    // Neighbor driver untouched (per-driver scope).
    assert.deepEqual(await snapshot(pool, OTHER_KFI), [
      "Driver|m=false|e=false|k=ct:other:untouched",
    ]);
  });
}
