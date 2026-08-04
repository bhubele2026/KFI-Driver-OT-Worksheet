/* One-shot prod cleanup, approved 2026-08-04:
 *  1) delete driver_id_aliases 10747/10607 → 2005201 (bad Burnett picks)
 *  2) week 2026-07-26 sweep: delete Customer-source punches for drivers
 *     with ZERO Connecteam (Driver-source) time that week, with
 *     punch_deletions audit rows in the same transaction
 *  3) delete the empty duplicate customers row "Delallo" (exact spelling)
 * Usage: node cleanup-2026-08-04.cjs report|apply
 */
const { Client } = require("pg");

const WEEK = "2026-07-26";
const MODE = process.argv[2] === "apply" ? "apply" : "report";

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const aliases = await c.query(
    `SELECT external_id, kfi_id, customer, sample_name, created_by, created_at
       FROM driver_id_aliases WHERE external_id IN ('10747','10607')`,
  );
  console.log("ALIASES:", JSON.stringify(aliases.rows, null, 1));

  const sweep = await c.query(
    `SELECT p.kfi_id, MAX(d.name) AS name, p.customer,
            COUNT(*)::int AS rows, SUM(p.hours) AS hrs
       FROM punches p LEFT JOIN drivers d ON d.kfi_id = p.kfi_id
      WHERE p.week_start = $1 AND p.source = 'Customer'
        AND NOT EXISTS (SELECT 1 FROM punches ct
                         WHERE ct.week_start = $1 AND ct.source = 'Driver'
                           AND ct.kfi_id = p.kfi_id)
      GROUP BY p.kfi_id, p.customer ORDER BY hrs DESC`,
    [WEEK],
  );
  console.log("SWEEP (zero-CT customer punches, week " + WEEK + "):");
  console.log(JSON.stringify(sweep.rows, null, 1));

  const delallo = await c.query(
    `SELECT id, display_name, active FROM customers WHERE lower(display_name) = 'delallo' ORDER BY id`,
  );
  console.log("DELALLO ROWS:", JSON.stringify(delallo.rows));
  for (const r of delallo.rows) {
    const refs = await c.query(
      `SELECT
         (SELECT COUNT(*) FROM punches WHERE customer = $1)::int AS punches,
         (SELECT COUNT(*) FROM customer_name_aliases WHERE customer = $1)::int AS name_aliases,
         (SELECT COUNT(*) FROM customer_upload_attempts WHERE customer = $1)::int AS upload_attempts,
         (SELECT COUNT(*) FROM ai_extract_samples WHERE customer = $1)::int AS samples,
         (SELECT COUNT(*) FROM customer_upload_chats WHERE customer = $1)::int AS chats,
         (SELECT COUNT(*) FROM customer_extraction_lessons WHERE customer = $1)::int AS lessons,
         (SELECT COUNT(*) FROM driver_id_aliases WHERE customer = $1)::int AS id_aliases`,
      [r.display_name],
    );
    console.log(`REFS for "${r.display_name}" (id ${r.id}):`, JSON.stringify(refs.rows[0]));
  }

  if (MODE === "apply") {
    await c.query("BEGIN");
    try {
      const delAliases = await c.query(
        `DELETE FROM driver_id_aliases
          WHERE external_id IN ('10747','10607') AND kfi_id = '2005201'
          RETURNING external_id, kfi_id`,
      );
      console.log("DELETED ALIASES:", JSON.stringify(delAliases.rows));

      const audit = await c.query(
        `INSERT INTO punch_deletions (punch_id, week_start, kfi_id, customer, source, deleted_by)
         SELECT p.id, p.week_start, p.kfi_id, p.customer, p.source, NULL
           FROM punches p
          WHERE p.week_start = $1 AND p.source = 'Customer'
            AND NOT EXISTS (SELECT 1 FROM punches ct
                             WHERE ct.week_start = $1 AND ct.source = 'Driver'
                               AND ct.kfi_id = p.kfi_id)
          RETURNING punch_id`,
        [WEEK],
      );
      const delPunches = await c.query(
        `DELETE FROM punches p
          WHERE p.week_start = $1 AND p.source = 'Customer'
            AND NOT EXISTS (SELECT 1 FROM punches ct
                             WHERE ct.week_start = $1 AND ct.source = 'Driver'
                               AND ct.kfi_id = p.kfi_id)
          RETURNING p.id`,
        [WEEK],
      );
      if (audit.rows.length !== delPunches.rows.length) {
        throw new Error(
          `audit/delete mismatch: ${audit.rows.length} audited vs ${delPunches.rows.length} deleted`,
        );
      }
      console.log(`DELETED ${delPunches.rows.length} zero-CT customer punches (audited)`);

      // Only the EXACT dup spelling, and only if truly unreferenced.
      const dupRefs = await c.query(
        `SELECT
           (SELECT COUNT(*) FROM punches WHERE customer = 'Delallo')::int +
           (SELECT COUNT(*) FROM customer_name_aliases WHERE customer = 'Delallo')::int +
           (SELECT COUNT(*) FROM customer_upload_attempts WHERE customer = 'Delallo')::int +
           (SELECT COUNT(*) FROM ai_extract_samples WHERE customer = 'Delallo')::int +
           (SELECT COUNT(*) FROM customer_upload_chats WHERE customer = 'Delallo')::int AS total`,
      );
      if (dupRefs.rows[0].total === 0) {
        const delCust = await c.query(
          `DELETE FROM customers WHERE display_name = 'Delallo' RETURNING id, display_name`,
        );
        console.log("DELETED CUSTOMER ROW:", JSON.stringify(delCust.rows));
      } else {
        console.log("SKIPPED Delallo delete — has references:", dupRefs.rows[0].total);
      }

      await c.query("COMMIT");
      console.log("APPLIED OK");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  } else {
    console.log("(report mode — nothing changed)");
  }
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
