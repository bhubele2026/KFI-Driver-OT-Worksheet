/* Read-only audit: which known (active) drivers are missing pay/bill
 * rate info in driver_payroll_profiles. */
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const rows = await c.query(`
    SELECT d.kfi_id, d.name, d.customer,
           (pp.kfi_id IS NOT NULL) AS has_profile,
           pp.rt_pay_rate, pp.rt_bill_rate, pp.ot_pay_rate, pp.ot_bill_rate,
           pp.driver_rt_pay_rate, pp.driver_rt_bill_rate,
           pp.driver_ot_pay_rate, pp.driver_ot_bill_rate,
           (SELECT COUNT(*)::int FROM punches p
             WHERE p.kfi_id = d.kfi_id AND p.week_start >= '2026-07-01') AS recent_punches
      FROM drivers d
      LEFT JOIN driver_payroll_profiles pp ON pp.kfi_id = d.kfi_id
     WHERE COALESCE(d.deactivated, false) = false
       AND d.kfi_id !~* 'e2e' AND d.name !~* 'e2e'
     ORDER BY has_profile ASC, recent_punches DESC, d.name`);
  const RATE_KEYS = [
    "rt_pay_rate","rt_bill_rate","ot_pay_rate","ot_bill_rate",
    "driver_rt_pay_rate","driver_rt_bill_rate","driver_ot_pay_rate","driver_ot_bill_rate",
  ];
  let complete = 0;
  const problems = [];
  for (const r of rows.rows) {
    const missing = RATE_KEYS.filter((k) => r[k] == null);
    if (!r.has_profile) {
      problems.push({ kfiId: r.kfi_id, name: r.name, customer: r.customer, recent: r.recent_punches, issue: "NO PROFILE" });
    } else if (missing.length > 0) {
      problems.push({ kfiId: r.kfi_id, name: r.name, customer: r.customer, recent: r.recent_punches, issue: "missing: " + missing.join(",") });
    } else {
      complete++;
    }
  }
  console.log(`ACTIVE DRIVERS: ${rows.rows.length}; complete profiles: ${complete}; needing info: ${problems.length}`);
  console.log(JSON.stringify(problems, null, 1));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
