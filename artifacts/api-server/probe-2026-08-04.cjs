/* Read-only probe: why did the sweep find nothing, and where does the
 * second "Delallo" tile come from? */
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const wk = "2026-07-26";
  const ids = ["2005201", "2005266", "2005265", "2005706"];

  const bySource = await c.query(
    `SELECT kfi_id, source, week_start::text, COUNT(*)::int AS rows, SUM(hours) AS hrs,
            MIN(date::text) AS first_day, MAX(date::text) AS last_day
       FROM punches WHERE kfi_id = ANY($1)
      GROUP BY kfi_id, source, week_start ORDER BY kfi_id, week_start, source`,
    [ids],
  );
  console.log("PUNCHES BY SOURCE (all weeks, 4 suspect drivers):");
  console.log(JSON.stringify(bySource.rows, null, 1));

  const sweepWide = await c.query(
    `SELECT p.kfi_id, MAX(d.name) AS name, p.customer,
            COUNT(*)::int AS c_rows, SUM(p.hours) AS c_hrs,
            (SELECT COALESCE(SUM(ct.hours),0) FROM punches ct
              WHERE ct.week_start=$1 AND ct.source='Driver' AND ct.kfi_id=p.kfi_id) AS driver_hrs
       FROM punches p LEFT JOIN drivers d ON d.kfi_id = p.kfi_id
      WHERE p.week_start = $1 AND p.source = 'Customer'
      GROUP BY p.kfi_id, p.customer ORDER BY driver_hrs ASC, c_hrs DESC LIMIT 15`,
    [wk],
  );
  console.log("WEEK " + wk + " customer punches w/ driver-hour totals (lowest first):");
  console.log(JSON.stringify(sweepWide.rows, null, 1));

  const delallo = await c.query(
    `SELECT 'punches' AS t, COUNT(*)::int AS n FROM punches WHERE customer = 'Delallo'
     UNION ALL SELECT 'upload_attempts', COUNT(*)::int FROM customer_upload_attempts WHERE customer = 'Delallo'
     UNION ALL SELECT 'samples', COUNT(*)::int FROM ai_extract_samples WHERE customer = 'Delallo'
     UNION ALL SELECT 'chats', COUNT(*)::int FROM customer_upload_chats WHERE customer = 'Delallo'
     UNION ALL SELECT 'tz_prefs', COUNT(*)::int FROM customer_tz_preferences WHERE customer = 'Delallo'
     UNION ALL SELECT 'name_aliases', COUNT(*)::int FROM customer_name_aliases WHERE customer = 'Delallo'`,
  );
  console.log("EXACT 'Delallo' REFS:", JSON.stringify(delallo.rows));

  const custNames = await c.query(
    `SELECT DISTINCT customer FROM punches WHERE lower(customer) LIKE 'del%'
     UNION SELECT DISTINCT customer FROM customer_upload_attempts WHERE lower(customer) LIKE 'del%'`,
  );
  console.log("DISTINCT del* customer strings:", JSON.stringify(custNames.rows));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
