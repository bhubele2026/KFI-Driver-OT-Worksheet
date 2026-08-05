/* Read-only verification: build the Zenople export rows for a week exactly
 * as the route does (live Zenople merge included), WITHOUT the review gate,
 * and print TSV for diffing against the SharePoint reference. No writes. */
import { asc, eq } from "drizzle-orm";
import { db, schema } from "./src/lib/db.js";
import {
  buildZenopleRows,
  mergeProfileWithLive,
  type ZenopleDriverInput,
  type ZenopleProfile,
} from "./src/lib/zenopleExport.js";
import { loadZenopleExportFacts } from "./src/lib/zenopleRates.js";
import { computeDriverTotals } from "./src/lib/hoursEngine.js";

const WEEK = process.argv[2] ?? "2026-07-19";

function profileFromRow(row: typeof schema.driverPayrollProfilesTable.$inferSelect | null): ZenopleProfile {
  const num = (v: string | null): number | null => (v == null ? null : Number(v));
  if (!row)
    return {
      ssn: null, jobId: null, personId: null, assignmentId: null, zenopleCustomer: null,
      rtPayRate: null, rtBillRate: null, otPayRate: null, otBillRate: null,
      driverRtPayRate: null, driverRtBillRate: null, driverOtPayRate: null, driverOtBillRate: null,
    };
  return {
    ssn: row.ssn, jobId: row.jobId, personId: row.personId, assignmentId: row.assignmentId,
    zenopleCustomer: row.zenopleCustomer,
    rtPayRate: num(row.rtPayRate), rtBillRate: num(row.rtBillRate),
    otPayRate: num(row.otPayRate), otBillRate: num(row.otBillRate),
    driverRtPayRate: num(row.driverRtPayRate), driverRtBillRate: num(row.driverRtBillRate),
    driverOtPayRate: num(row.driverOtPayRate), driverOtBillRate: num(row.driverOtBillRate),
  };
}

(async () => {
  const punches = await db.select().from(schema.punchesTable)
    .where(eq(schema.punchesTable.weekStart, WEEK))
    .orderBy(asc(schema.punchesTable.kfiId));
  const punchesByKfi = new Map<string, typeof punches>();
  for (const p of punches) {
    (punchesByKfi.get(p.kfiId) ?? punchesByKfi.set(p.kfiId, []).get(p.kfiId)!).push(p);
  }
  const drivers = await db.select({ kfiId: schema.driversTable.kfiId, name: schema.driversTable.name }).from(schema.driversTable);
  const driverByKfi = new Map(drivers.map((d) => [d.kfiId, d]));
  const profilesArr = await db.select().from(schema.driverPayrollProfilesTable);
  const profiles = new Map(profilesArr.map((p) => [p.kfiId, p]));

  const liveFacts = await loadZenopleExportFacts();
  console.error(`liveFacts: ${liveFacts.size} persons`);

  const inputs: ZenopleDriverInput[] = [...punchesByKfi.keys()]
    .map((kfiId) => {
      const d = driverByKfi.get(kfiId);
      const stored = profileFromRow(profiles.get(kfiId) ?? null);
      const live = liveFacts.get(kfiId) ?? (stored.personId != null ? liveFacts.get(String(stored.personId)) : undefined);
      return {
        kfiId,
        name: d?.name ?? kfiId,
        zenopleName: live?.personLabel ?? null,
        profile: mergeProfileWithLive(stored, live),
        punches: punchesByKfi.get(kfiId)!,
      };
    })
    .filter((d) => {
      const t = computeDriverTotals(d.punches);
      return t.custRt + t.custOt + t.driverRt + t.driverOt > 0;
    });

  const rows = buildZenopleRows(inputs, WEEK);
  console.log(["Customer","Person","SSN","JobId","PersonId","Code","PayUnit","PayRate","BillRate","PPE","AsgId"].join("\t"));
  for (const r of rows) {
    console.log([r.customer, r.person, r.ssn, r.jobId, r.personId, r.code, r.payUnit, r.payRate, r.billRate, r.ppe, r.assignmentId].join("\t"));
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
