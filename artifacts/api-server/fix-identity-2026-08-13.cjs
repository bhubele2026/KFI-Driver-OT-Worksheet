/**
 * Correct poisoned identity rows in driver_payroll_profiles (Brad-approved
 * 2026-08-13). Temporary — delete after use.
 *
 *  - Jose Gallegos: the name-fingerprint backfill attached Zenople person
 *    2002374 ("Gallegos, Jose", Burnett Dairy - Grantsburg) to the app's
 *    driver, who is 2006023 ("GALLEGOS, JOSE ARMANDO", Shuster's Building
 *    Components, assignment 3501, job 832, SSN ...0918).
 *  - Ramon Almeida Ruiz: person_id 204067 is missing a digit (Zenople has
 *    2004067; his stored assignment 2879 / job 714 already match that person),
 *    and zenople_customer carries the legacy spelling "Burnett Dairy-Grantsburg"
 *    where Zenople's Organization is "Burnett Dairy - Grantsburg".
 */
const { Client } = require("pg");

const FIXES = [
  {
    match: "Jose Gallegos",
    expect: { person_id: 2002374 },
    set: {
      person_id: 2006023,
      assignment_id: 3501,
      job_id: 832,
      zenople_customer: "Shuster's Building Components",
      ssn: "XXX-XX-0918",
    },
  },
  {
    match: "Ramon Almeida Ruiz",
    expect: { person_id: 204067 },
    set: {
      person_id: 2004067,
      zenople_customer: "Burnett Dairy - Grantsburg",
      ssn: "XXX-XX-5444",
    },
  },
];

const COLS = ["ssn", "job_id", "person_id", "assignment_id", "zenople_customer"];

(async () => {
  const apply = process.argv.includes("--apply");
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("BEGIN");
  try {
    for (const f of FIXES) {
      const { rows } = await c.query(
        `SELECT d.kfi_id, d.name, ${COLS.map((x) => "p." + x).join(", ")}
           FROM drivers d JOIN driver_payroll_profiles p ON p.kfi_id = d.kfi_id
          WHERE d.name = $1 AND COALESCE(d.deactivated,false)=false`,
        [f.match],
      );
      if (rows.length !== 1) throw new Error(`${f.match}: expected 1 row, got ${rows.length}`);
      const before = rows[0];
      if (Number(before.person_id) !== f.expect.person_id)
        throw new Error(`${f.match}: expected person_id ${f.expect.person_id}, found ${before.person_id} — aborting`);

      const keys = Object.keys(f.set);
      console.log(`\n${f.match} (kfi_id ${before.kfi_id})`);
      for (const k of COLS) {
        const to = k in f.set ? f.set[k] : before[k];
        const changed = String(before[k]) !== String(to);
        console.log(`  ${k.padEnd(18)} ${String(before[k]).padEnd(30)} ${changed ? "->  " + to : "(unchanged)"}`);
      }
      if (apply) {
        await c.query(
          `UPDATE driver_payroll_profiles
              SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now()
            WHERE kfi_id = $1`,
          [before.kfi_id, ...keys.map((k) => f.set[k])],
        );
      }
    }
    if (apply) {
      await c.query(
        `INSERT INTO data_mutation_audit (routine, outcome, rows_affected, started_at, finished_at, detail)
         VALUES ($1,$2,$3, now(), now(), $4)`,
        ["fixPoisonedPayrollIdentity", "ok", FIXES.length,
         "Brad-approved 2026-08-13: Gallegos 2002374->2006023 (Shuster's, asg 3501, job 832); Almeida Ruiz 204067->2004067 + org spelling"],
      );
      await c.query("COMMIT");
      console.log("\nAPPLIED + audited.");
    } else {
      await c.query("ROLLBACK");
      console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    }
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("\nROLLED BACK:", e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
