/**
 * READ-ONLY audit: which drivers' stored payroll identity belongs to a
 * DIFFERENT Zenople human, or points at a customer they don't work at.
 * Temporary — delete after use.
 */
const { Client } = require("pg");
const fs = require("node:fs");

const env = Object.fromEntries(
  fs.readFileSync(process.env.HOME + "/projects/KFI-Accrual/.env", "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

const fp = (raw) => String(raw ?? "").toUpperCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/,/g, " ").replace(/\./g, " ")
  .replace(/\b(JR|SR|II|III|IV)\b/g, "").split(/\s+/).map((t) => t.trim())
  .filter((t) => t.length > 1).sort().join(" ");

(async () => {
  const base = (env.ZENOPLE_BASE_URL || "https://kfistaffingapi.zenople.com").replace(/\/+$/, "");
  const tok = await (await fetch(`${base}/connect/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.ZENOPLE_CLIENT_ID, client_secret: env.ZENOPLE_CLIENT_SECRET }),
  })).json();
  const toUtc = (d) => d.toISOString().replace("T", " ").replace("Z", "0000");
  const now = new Date();
  const asg = await (await fetch(`${base}/api/common/data`, {
    method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "AssignmentData", filters: { uTCStartDateTime: toUtc(new Date(now - 365 * 864e5)), uTCEndDateTime: toUtc(now), includeData: "Current" } }),
  })).json();

  const byPerson = new Map();
  for (const a of asg) {
    const pid = String(a.PersonId ?? ""); if (!pid) continue;
    if (!byPerson.has(pid)) byPerson.set(pid, { name: `${a.LastName ?? ""}, ${a.FirstName ?? ""} ${a.MiddleName ?? ""}`.replace(/\s+/g, " ").trim(), orgs: new Set(), active: new Set() });
    const e = byPerson.get(pid);
    e.orgs.add(a.Organization);
    if (a.IsActiveToday === true) e.active.add(a.Organization);
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(`
    SELECT d.kfi_id, d.name, d.customer AS roster, o.override_customer,
           p.person_id, p.zenople_customer, p.job_id, p.assignment_id, p.ssn
      FROM drivers d
      LEFT JOIN driver_customer_overrides o ON o.kfi_id = d.kfi_id
      JOIN driver_payroll_profiles p ON p.kfi_id = d.kfi_id
     WHERE COALESCE(d.deactivated,false)=false
       AND d.kfi_id !~* 'e2e' AND d.name !~* 'e2e'
       AND COALESCE(d.customer,'') NOT ILIKE 'zz%'
     ORDER BY d.name`);

  const dupPid = new Map();
  for (const r of rows) if (r.person_id != null) (dupPid.get(String(r.person_id)) ?? dupPid.set(String(r.person_id), []).get(String(r.person_id))).push(r.name);

  console.log(`\n${rows.length} active drivers with a payroll profile\n`);
  const bad = [];
  for (const r of rows) {
    const app = r.override_customer ?? r.roster;
    const z = r.person_id != null ? byPerson.get(String(r.person_id)) : null;
    const flags = [];
    if (r.person_id == null) flags.push("NO-PERSONID");
    else if (!z) flags.push("PERSONID-NOT-IN-ZENOPLE");
    else {
      const df = fp(r.name), zf = fp(z.name);
      const dt = new Set(df.split(" ")), zt = new Set(zf.split(" "));
      const shared = [...dt].filter((t) => zt.has(t)).length;
      if (shared === 0) flags.push(`WRONG-PERSON? stored=${z.name}`);
      else if (df !== zf) flags.push(`name-variant(${z.name})`);
      if (r.zenople_customer && !z.orgs.has(r.zenople_customer)) flags.push(`CUSTOMER-NOT-THIS-PERSONS(${r.zenople_customer})`);
      if (dupPid.get(String(r.person_id)).length > 1) flags.push(`SHARED-PERSONID with ${dupPid.get(String(r.person_id)).filter((n) => n !== r.name).join("/")}`);
    }
    const hard = flags.some((f) => /WRONG-PERSON|SHARED-PERSONID|CUSTOMER-NOT-THIS|NOT-IN-ZENOPLE|NO-PERSONID/.test(f));
    if (hard) bad.push(r);
    console.log(`${hard ? "✖" : flags.length ? "•" : "✔"} ${r.name.padEnd(26)} app=${String(app).padEnd(30)} stored=${String(r.zenople_customer).padEnd(32)} pid=${r.person_id} asg=${r.assignment_id} job=${r.job_id}${flags.length ? "\n    " + flags.join(" | ") : ""}`);
    if (hard && z) console.log(`    zenople person ${r.person_id} = ${z.name} | active at: ${[...z.active].join(", ") || "(none)"} | ever: ${[...z.orgs].join(", ")}`);
  }
  console.log(`\n=== ${bad.length} driver(s) need attention ===`);
  await c.end();
})();
