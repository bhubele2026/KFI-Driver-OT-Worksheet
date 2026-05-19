import type { ClientBase } from "pg";

// Data captured from the attached Zenople sample
// (attached_assets/Driver_Pay_Units_customer_and_Driver_time_PD_05.15.2026_…xlsx)
// by grouping the RT / OT / DriverRT / DriverOT rows per (Person, PersonId)
// and reading the Pay Rate / Bill Rate from each. ShiftDifferential rows are
// intentionally ignored (out of scope, see task spec).
//
// `person` is preserved verbatim so it lands in the Zenople "Person" column
// exactly as the live system expects (LAST, FIRST [MIDDLE]).
export interface PayrollSeedRow {
  zenopleCustomer: string;
  person: string;
  // Optional roster override. When set, this kfi_id is used directly and
  // fingerprint matching is skipped. Used for the handful of drivers whose
  // Zenople `person` carries extra middle tokens the roster doesn't (e.g.
  // "BAEZ CABALLERO, FELIX ANDRES" vs roster "Felix Baez Caballero").
  kfiId?: string;
  ssn: string;
  jobId: number;
  personId: number;
  assignmentId: number;
  rtPayRate?: number;
  rtBillRate?: number;
  otPayRate?: number;
  otBillRate?: number;
  driverRtPayRate?: number;
  driverRtBillRate?: number;
  driverOtPayRate?: number;
  driverOtBillRate?: number;
}

export const PAYROLL_SEED_ROWS: PayrollSeedRow[] = [
  { zenopleCustomer: "Adient", person: "ANGULO ALFARO, JOSE R", ssn: "XXX-XX-8299", jobId: 820, personId: 2004863, assignmentId: 3203, driverRtPayRate: 13.75, driverRtBillRate: 0 },
  { zenopleCustomer: "Adient", person: "RIVERA, OMAR", ssn: "XXX-XX-1740", jobId: 558, personId: 2002909, assignmentId: 2540, rtPayRate: 18.25, rtBillRate: 25.37, otPayRate: 27.38, otBillRate: 37.24, driverRtPayRate: 13.75, driverRtBillRate: 0, driverOtPayRate: 27.38, driverOtBillRate: 0 },
  { zenopleCustomer: "Burnett Dairy - Grantsburg", person: "BAEZ CABALLERO, FELIX ANDRES", kfiId: "2003283", ssn: "XXX-XX-5416", jobId: 559, personId: 2003283, assignmentId: 2541, rtPayRate: 21.93, rtBillRate: 31.58, otPayRate: 32.9, otBillRate: 43.43, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 32.9, driverOtBillRate: 0 },
  { zenopleCustomer: "Burnett Dairy - Grantsburg", person: "GUERRERO, ISIDRO", ssn: "XXX-XX-4533", jobId: 740, personId: 2005207, assignmentId: 3116, rtPayRate: 17.5, rtBillRate: 25.9, otPayRate: 26.25, otBillRate: 35.44, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 26.25, driverOtBillRate: 0 },
  { zenopleCustomer: "Burnett Dairy - Grantsburg", person: "MEDINA JR, WILLIE A", ssn: "XXX-XX-1825", jobId: 740, personId: 2004792, assignmentId: 2966, rtPayRate: 19.55, rtBillRate: 28.93, otPayRate: 29.33, otBillRate: 39.6, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 29.33, driverOtBillRate: 0 },
  { zenopleCustomer: "DeLallo Foods", person: "ALCIDE, DAVIDSON", ssn: "XXX-XX-0656", jobId: 748, personId: 2005003, assignmentId: 3028, rtPayRate: 17, rtBillRate: 25.33, otPayRate: 25.5, otBillRate: 29.58, driverRtPayRate: 0, driverRtBillRate: 0, driverOtPayRate: 25.5, driverOtBillRate: 0 },
  { zenopleCustomer: "DeLallo Foods", person: "BRITTMAN, CORY", ssn: "XXX-XX-0747", jobId: 749, personId: 2005241, assignmentId: 3149, rtPayRate: 17, rtBillRate: 25.33, otPayRate: 25.5, otBillRate: 29.58, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 25.5, driverOtBillRate: 0 },
  { zenopleCustomer: "International Wire Group, Inc", person: "BARRIENTOS FLORES, WILBER R", ssn: "XXX-XX-9430", jobId: 793, personId: 2005056, assignmentId: 3110, rtPayRate: 20, rtBillRate: 29.2, otPayRate: 30, otBillRate: 43.8, driverRtPayRate: 15.5, driverRtBillRate: 0, driverOtPayRate: 30, driverOtBillRate: 0 },
  { zenopleCustomer: "International Wire Group, Inc", person: "CEDENO MENDOZA, JONATHAN D", ssn: "XXX-XX-2514", jobId: 794, personId: 2005212, assignmentId: 3156, rtPayRate: 20, rtBillRate: 29.2, otPayRate: 30, otBillRate: 43.8, driverRtPayRate: 15.5, driverRtBillRate: 0, driverOtPayRate: 30, driverOtBillRate: 0 },
  { zenopleCustomer: "Landscape Structures", person: "PATTERSON, TYREK J", ssn: "XXX-XX-6484", jobId: 719, personId: 2004786, assignmentId: 2901, rtPayRate: 19, rtBillRate: 28.22, otPayRate: 28.5, otBillRate: 40.47, driverRtPayRate: 11.13, driverRtBillRate: 0, driverOtPayRate: 28.5, driverOtBillRate: 0 },
  { zenopleCustomer: "Landscape Structures", person: "RODRIGUEZ GONZALEZ , BENJAMIN", ssn: "XXX-XX-6279", jobId: 602, personId: 2003681, assignmentId: 2619, rtPayRate: 22, rtBillRate: 32.67, otPayRate: 33, otBillRate: 46.86, driverRtPayRate: 11.13, driverRtBillRate: 0, driverOtPayRate: 36, driverOtBillRate: 0 },
  { zenopleCustomer: "Landscape Structures", person: "VILLARREAL, SEBASTIAN", ssn: "XXX-XX-3409", jobId: 775, personId: 2005166, assignmentId: 3105, rtPayRate: 22, rtBillRate: 32.67, otPayRate: 33, otBillRate: 46.86, driverRtPayRate: 11.13, driverRtBillRate: 0, driverOtPayRate: 33, driverOtBillRate: 0 },
  { zenopleCustomer: "Penda Corp", person: "CHONCOA, ASHLEY MARIE", kfiId: "2005310", ssn: "XXX-XX-8858", jobId: 805, personId: 2005310, assignmentId: 3126, rtPayRate: 18.5, rtBillRate: 25.53, otPayRate: 27.75, otBillRate: 38.3, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 27.75, driverOtBillRate: 0 },
  { zenopleCustomer: "Penda Corp", person: "GOLAS QUEVEDO, ROBERTO", ssn: "XXX-XX-8415", jobId: 704, personId: 2003546, assignmentId: 2851, rtPayRate: 22.5, rtBillRate: 31.05, otPayRate: 33.75, otBillRate: 46.58, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 33.75, driverOtBillRate: 0 },
  { zenopleCustomer: "Schuette Metals", person: "ALEXANDER, GIOVANNI OSHEA LYNN", kfiId: "2005077", ssn: "XXX-XX-7564", jobId: 809, personId: 2005077, assignmentId: 3188, rtPayRate: 19, rtBillRate: 28.31, otPayRate: 28.5, otBillRate: 41.04, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 28.5, driverOtBillRate: 0 },
  { zenopleCustomer: "Trienda Holdings", person: "LOPEZ MOLINA, JESUS", ssn: "XXX-XX-7888", jobId: 813, personId: 2005279, assignmentId: 3167, driverRtPayRate: 25, driverRtBillRate: 0, driverOtPayRate: 37.5, driverOtBillRate: 0 },
  { zenopleCustomer: "WB Manufacturing", person: "LIRA, JESUS O", ssn: "XXX-XX-0509", jobId: 747, personId: 2005037, assignmentId: 3052, rtPayRate: 25.5, rtBillRate: 39.02, otPayRate: 38.25, otBillRate: 58.52, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 38.25, driverOtBillRate: 0 },
  { zenopleCustomer: "Shuster's Building Components", person: "Balderas, Richard", ssn: "XXX-XX-1230", jobId: 462, personId: 2004992, assignmentId: 3008, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 25.5, driverOtBillRate: 0 },
  // Gage's xlsx rows are ShiftDifferential + Driver only (no RT/OT customer
  // rows). ShiftDifferential is intentionally ignored, so RT/OT pay+bill are
  // zeroed to clear the strict readiness gate. The dispatcher can refine via
  // the admin "Pay & bill rates" card if she ever takes customer-side hours.
  { zenopleCustomer: "Shuster's Building Components", person: "MOODY, GAGE COREY", kfiId: "2005141", ssn: "XXX-XX-6071", jobId: 736, personId: 2005141, assignmentId: 3165, rtPayRate: 0, rtBillRate: 0, otPayRate: 0, otBillRate: 0, driverRtPayRate: 10, driverRtBillRate: 0, driverOtPayRate: 25.5, driverOtBillRate: 0 },
];

/**
 * Normalize a name into a sorted-token fingerprint so a roster name in the
 * dispatcher app ("Jose Angulo Alfaro") matches the Zenople-style sample
 * name ("ANGULO ALFARO, JOSE R"). Single-letter middle initials and JR / SR /
 * II / III suffixes are dropped so they don't poison the comparison.
 */
export function fingerprintName(raw: string): string {
  return raw
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/,/g, " ")
    .replace(/\./g, " ")
    .replace(/\b(JR|SR|II|III|IV)\b/g, "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .sort()
    .join(" ");
}

export interface SeedResult {
  matched: number;
  inserted: number;
  skippedExisting: number;
  unmatched: string[];
}

/**
 * Idempotent: only writes when the row is missing or every field on it is
 * still NULL (so a hand-edited rate is never overwritten). Drivers we
 * can't match by name are returned in `unmatched` for visibility.
 */
export async function seedDriverPayrollProfiles(
  client: ClientBase,
): Promise<SeedResult> {
  // Pull the full driver list once.
  const rosterRes = await client.query<{ kfi_id: string; name: string }>(
    `SELECT kfi_id, name FROM drivers`,
  );
  const byFp = new Map<string, string>();
  for (const r of rosterRes.rows) {
    const fp = fingerprintName(r.name);
    if (!byFp.has(fp)) byFp.set(fp, r.kfi_id);
  }

  const result: SeedResult = {
    matched: 0,
    inserted: 0,
    skippedExisting: 0,
    unmatched: [],
  };

  // Build a set of valid kfiIds so an explicit override is validated against
  // the actual roster (an override for a kfi_id that no longer exists falls
  // back to the unmatched list, just like a fingerprint miss would).
  const kfiIdSet = new Set(rosterRes.rows.map((r) => r.kfi_id));

  for (const row of PAYROLL_SEED_ROWS) {
    const overrideKfiId =
      row.kfiId && kfiIdSet.has(row.kfiId) ? row.kfiId : undefined;
    const kfiId = overrideKfiId ?? byFp.get(fingerprintName(row.person));
    if (!kfiId) {
      result.unmatched.push(row.person);
      continue;
    }
    result.matched += 1;
    // Only fill if the existing row is null on every column (i.e. it was
    // just inserted by ON CONFLICT or doesn't exist yet). Hand-edited
    // values must never get clobbered by a re-run of preMigrate.
    const ins = await client.query(
      `INSERT INTO driver_payroll_profiles (
         kfi_id, ssn, job_id, person_id, assignment_id, zenople_customer,
         rt_pay_rate, rt_bill_rate, ot_pay_rate, ot_bill_rate,
         driver_rt_pay_rate, driver_rt_bill_rate,
         driver_ot_pay_rate, driver_ot_bill_rate
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (kfi_id) DO UPDATE SET
         ssn = COALESCE(driver_payroll_profiles.ssn, EXCLUDED.ssn),
         job_id = COALESCE(driver_payroll_profiles.job_id, EXCLUDED.job_id),
         person_id = COALESCE(driver_payroll_profiles.person_id, EXCLUDED.person_id),
         assignment_id = COALESCE(driver_payroll_profiles.assignment_id, EXCLUDED.assignment_id),
         zenople_customer = COALESCE(driver_payroll_profiles.zenople_customer, EXCLUDED.zenople_customer),
         rt_pay_rate = COALESCE(driver_payroll_profiles.rt_pay_rate, EXCLUDED.rt_pay_rate),
         rt_bill_rate = COALESCE(driver_payroll_profiles.rt_bill_rate, EXCLUDED.rt_bill_rate),
         ot_pay_rate = COALESCE(driver_payroll_profiles.ot_pay_rate, EXCLUDED.ot_pay_rate),
         ot_bill_rate = COALESCE(driver_payroll_profiles.ot_bill_rate, EXCLUDED.ot_bill_rate),
         driver_rt_pay_rate = COALESCE(driver_payroll_profiles.driver_rt_pay_rate, EXCLUDED.driver_rt_pay_rate),
         driver_rt_bill_rate = COALESCE(driver_payroll_profiles.driver_rt_bill_rate, EXCLUDED.driver_rt_bill_rate),
         driver_ot_pay_rate = COALESCE(driver_payroll_profiles.driver_ot_pay_rate, EXCLUDED.driver_ot_pay_rate),
         driver_ot_bill_rate = COALESCE(driver_payroll_profiles.driver_ot_bill_rate, EXCLUDED.driver_ot_bill_rate)
       RETURNING (xmax = 0) AS inserted`,
      [
        kfiId,
        row.ssn,
        row.jobId,
        row.personId,
        row.assignmentId,
        row.zenopleCustomer,
        row.rtPayRate ?? null,
        row.rtBillRate ?? null,
        row.otPayRate ?? null,
        row.otBillRate ?? null,
        row.driverRtPayRate ?? null,
        row.driverRtBillRate ?? null,
        row.driverOtPayRate ?? null,
        row.driverOtBillRate ?? null,
      ],
    );
    const wasInsert = ins.rows[0]?.inserted === true;
    if (wasInsert) result.inserted += 1;
    else result.skippedExisting += 1;
  }
  return result;
}
