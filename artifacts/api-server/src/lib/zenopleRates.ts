/**
 * Zenople pay/bill rate backfill (2026-08-04, Brad: "get the info from
 * Zenople — you have the API").
 *
 * Source of truth per probe of the KFI tenant:
 *  - `AssignmentData` — one row per assignment with PayRate / BillRate,
 *    PersonId (= our kfi_id for real badge ids), JobId, AssignmentId,
 *    Organization, JobPosition ("Driver" is its own assignment lane), SSN.
 *  - `TransactionData` — per pay-period actuals; effective OT rates are
 *    OTPay/OTPayHours (verified: Lopez Molina 655.50/26.22h = his exact
 *    $25.00 driver rate).
 *
 * The backfill NEVER overwrites a non-null field — it only fills holes, so
 * hand-entered rates always win. Runs at boot (audited via
 * data_mutation_audit) and skips cleanly when ZENOPLE_* env is absent.
 */
import type { ClientBase } from "pg";
import { fingerprintName } from "@workspace/db/seedDriverPayrollProfiles";

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

function zenopleConfig() {
  return {
    baseUrl: (process.env.ZENOPLE_BASE_URL ?? "https://kfistaffingapi.zenople.com").replace(/\/+$/, ""),
    clientId: process.env.ZENOPLE_CLIENT_ID,
    clientSecret: process.env.ZENOPLE_CLIENT_SECRET,
  };
}

export function zenopleConfigured(): boolean {
  const c = zenopleConfig();
  return Boolean(c.clientId && c.clientSecret);
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const c = zenopleConfig();
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;
  const res = await fetch(`${c.baseUrl}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: c.clientId ?? "",
      client_secret: c.clientSecret ?? "",
    }),
  });
  if (!res.ok) throw new Error(`Zenople auth ${res.status}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Zenople auth returned no access_token");
  cachedToken = { token: json.access_token, expiresAt: now + (json.expires_in ?? 7200) * 1000 };
  return cachedToken.token;
}

const toUtc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "0000");

/** Widest window that the API will serve — retries narrower on "large data set". */
async function fetchAction(action: string): Promise<Record<string, unknown>[]> {
  const c = zenopleConfig();
  const token = await getToken();
  for (const days of [365, 180, 90, 45, 21]) {
    const now = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const res = await fetch(`${c.baseUrl}/api/common/data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        filters: {
          uTCStartDateTime: toUtc(start),
          uTCEndDateTime: toUtc(now),
          includeData: "Current",
        },
      }),
    });
    if (!res.ok) throw new Error(`Zenople ${action} ${res.status}`);
    const json = (await res.json()) as unknown;
    if (Array.isArray(json)) return json as Record<string, unknown>[];
    // non-array (e.g. {"msg":"Large data set"}) → narrow the window and retry
  }
  throw new Error(`Zenople ${action}: large data set at every window`);
}

// ---------------------------------------------------------------------------
// Rate computation (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface ProfileFill {
  ssn?: string;
  jobId?: number;
  personId?: number;
  assignmentId?: number;
  zenopleCustomer?: string;
  rtPayRate?: number;
  rtBillRate?: number;
  otPayRate?: number;
  otBillRate?: number;
  driverRtPayRate?: number;
  driverRtBillRate?: number;
  driverOtPayRate?: number;
  driverOtBillRate?: number;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);
const round2 = (v: number) => Math.round(Number((v * 100).toFixed(6))) / 100;
const isDriverLane = (jobPosition: unknown) => /driver/i.test(String(jobPosition ?? ""));

function maskSsn(raw: unknown): string | undefined {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 4) return undefined;
  return `XXX-XX-${digits.slice(-4)}`;
}

/** Latest, preferring currently-active assignments. */
function pickAssignment(rows: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const sorted = [...rows].sort((a, b) => {
    const activeA = a.IsActiveToday === true ? 1 : 0;
    const activeB = b.IsActiveToday === true ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    return String(b.StartDate ?? "").localeCompare(String(a.StartDate ?? ""));
  });
  return sorted[0];
}

/** Effective $/hr over a set of transaction rows for one pay/bill component. */
function effectiveRate(
  rows: Record<string, unknown>[],
  amountKey: string,
  hoursKey: string,
): number | undefined {
  let amount = 0;
  let hours = 0;
  for (const r of rows) {
    amount += num(r[amountKey]);
    hours += num(r[hoursKey]);
  }
  if (hours < 0.5) return undefined;
  return round2(amount / hours);
}

export function computeProfileFill(
  assignments: Record<string, unknown>[],
  transactions: Record<string, unknown>[],
): ProfileFill {
  const fill: ProfileFill = {};
  const driverAsg = pickAssignment(assignments.filter((a) => isDriverLane(a.JobPosition)));
  const customerAsg = pickAssignment(assignments.filter((a) => !isDriverLane(a.JobPosition)));
  const driverTx = transactions.filter((t) => isDriverLane(t.JobPosition));
  const customerTx = transactions.filter((t) => !isDriverLane(t.JobPosition));

  // Customer lane — RT from the assignment (authoritative), falling back to
  // effective actuals; OT pay falls back to the standard 1.5× only for PAY
  // (bill OT multiples vary by contract, so bill comes only from actuals).
  if (customerAsg) {
    fill.rtPayRate = round2(num(customerAsg.PayRate));
    fill.rtBillRate = round2(num(customerAsg.BillRate));
  } else {
    const rt = effectiveRate(customerTx, "RTPay", "RTPayHours");
    if (rt != null) fill.rtPayRate = rt;
    const rtBill = effectiveRate(customerTx, "RTBill", "RTBillHours");
    if (rtBill != null) fill.rtBillRate = rtBill;
  }
  const otPay = effectiveRate(customerTx, "OTPay", "OTPayHours");
  fill.otPayRate = otPay ?? (fill.rtPayRate != null ? round2(fill.rtPayRate * 1.5) : undefined);
  const otBill = effectiveRate(customerTx, "OTBill", "OTBillHours");
  if (otBill != null) fill.otBillRate = otBill;

  // Driver lane — same shape; Zenople bills driver time at 0, so a 0
  // assignment BillRate confidently zeroes both driver bill fields.
  if (driverAsg) {
    fill.driverRtPayRate = round2(num(driverAsg.PayRate));
    fill.driverRtBillRate = round2(num(driverAsg.BillRate));
  } else {
    const rt = effectiveRate(driverTx, "RTPay", "RTPayHours");
    if (rt != null) fill.driverRtPayRate = rt;
    const rtBill = effectiveRate(driverTx, "RTBill", "RTBillHours");
    if (rtBill != null) fill.driverRtBillRate = rtBill;
  }
  const dOtPay = effectiveRate(driverTx, "OTPay", "OTPayHours");
  // Driver OT is computed on the person's overall RT rate (seed data:
  // driver $10/hr people carry driverOt = 1.5 × their customer RT).
  const otBase = fill.rtPayRate ?? fill.driverRtPayRate;
  fill.driverOtPayRate =
    dOtPay ?? (fill.driverRtPayRate != null && otBase != null ? round2(otBase * 1.5) : undefined);
  const dOtBill = effectiveRate(driverTx, "OTBill", "OTBillHours");
  fill.driverOtBillRate =
    dOtBill ?? (fill.driverRtBillRate === 0 ? 0 : undefined);

  // Identifiers — prefer the driver assignment (matches the seed's
  // convention); customer lane fills the customer name.
  const idAsg = driverAsg ?? customerAsg;
  if (idAsg) {
    const ssn = maskSsn(idAsg.SSN);
    if (ssn) fill.ssn = ssn;
    if (num(idAsg.JobId) > 0) fill.jobId = num(idAsg.JobId);
    if (num(idAsg.PersonId) > 0) fill.personId = num(idAsg.PersonId);
    if (num(idAsg.AssignmentId) > 0) fill.assignmentId = num(idAsg.AssignmentId);
  }
  const org = (customerAsg?.Organization ?? driverAsg?.Organization) as string | undefined;
  if (org) fill.zenopleCustomer = org;

  return fill;
}

// ---------------------------------------------------------------------------
// Boot backfill
// ---------------------------------------------------------------------------

const PROFILE_COLUMNS: Array<{ col: string; key: keyof ProfileFill }> = [
  { col: "ssn", key: "ssn" },
  { col: "job_id", key: "jobId" },
  { col: "person_id", key: "personId" },
  { col: "assignment_id", key: "assignmentId" },
  { col: "zenople_customer", key: "zenopleCustomer" },
  { col: "rt_pay_rate", key: "rtPayRate" },
  { col: "rt_bill_rate", key: "rtBillRate" },
  { col: "ot_pay_rate", key: "otPayRate" },
  { col: "ot_bill_rate", key: "otBillRate" },
  { col: "driver_rt_pay_rate", key: "driverRtPayRate" },
  { col: "driver_rt_bill_rate", key: "driverRtBillRate" },
  { col: "driver_ot_pay_rate", key: "driverOtPayRate" },
  { col: "driver_ot_bill_rate", key: "driverOtBillRate" },
];

export interface BackfillResult {
  skipped: boolean;
  driversConsidered: number;
  driversFilled: number;
  fieldsFilled: number;
  noZenopleMatch: string[];
}

/**
 * Fill NULL payroll-profile fields for active drivers from Zenople. Matches
 * by PersonId == kfi_id first (real badge ids ARE Zenople person ids), then
 * by name fingerprint. Internal/test roster rows (customer starting "zz")
 * are skipped — they are not payroll drivers.
 */
export async function backfillPayrollProfilesFromZenople(
  client: ClientBase,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    skipped: false,
    driversConsidered: 0,
    driversFilled: 0,
    fieldsFilled: 0,
    noZenopleMatch: [],
  };
  if (!zenopleConfigured()) {
    result.skipped = true;
    return result;
  }

  const [assignments, transactions] = await Promise.all([
    fetchAction("AssignmentData"),
    fetchAction("TransactionData"),
  ]);
  const asgByPerson = new Map<string, Record<string, unknown>[]>();
  for (const a of assignments) {
    const pid = String(a.PersonId ?? "");
    if (!pid) continue;
    (asgByPerson.get(pid) ?? asgByPerson.set(pid, []).get(pid)!).push(a);
  }
  const txByPerson = new Map<string, Record<string, unknown>[]>();
  for (const t of transactions) {
    const pid = String(t.PersonId ?? "");
    if (!pid) continue;
    (txByPerson.get(pid) ?? txByPerson.set(pid, []).get(pid)!).push(t);
  }
  // Name-fingerprint fallback for drivers whose kfi_id is a Connecteam id.
  const personIdByFp = new Map<string, string>();
  for (const a of assignments) {
    const name = `${a.LastName ?? ""}, ${a.FirstName ?? ""} ${a.MiddleName ?? ""}`;
    const fp = fingerprintName(name);
    if (fp && !personIdByFp.has(fp)) personIdByFp.set(fp, String(a.PersonId ?? ""));
  }

  const drivers = await client.query<{
    kfi_id: string;
    name: string;
    customer: string | null;
  }>(
    `SELECT kfi_id, name, customer FROM drivers
      WHERE COALESCE(deactivated, false) = false
        AND kfi_id !~* 'e2e' AND name !~* 'e2e'
        AND COALESCE(customer, '') NOT ILIKE 'zz%'`,
  );
  const profiles = await client.query<Record<string, unknown>>(
    `SELECT * FROM driver_payroll_profiles`,
  );
  const profileByKfi = new Map<string, Record<string, unknown>>();
  for (const p of profiles.rows) profileByKfi.set(String(p.kfi_id), p);

  for (const d of drivers.rows) {
    result.driversConsidered++;
    let pid = asgByPerson.has(d.kfi_id) || txByPerson.has(d.kfi_id) ? d.kfi_id : null;
    if (!pid) pid = personIdByFp.get(fingerprintName(d.name)) ?? null;
    if (!pid || (!asgByPerson.has(pid) && !txByPerson.has(pid))) {
      result.noZenopleMatch.push(`${d.name} (${d.kfi_id})`);
      continue;
    }
    const fill = computeProfileFill(asgByPerson.get(pid) ?? [], txByPerson.get(pid) ?? []);
    const existing = profileByKfi.get(d.kfi_id);
    const updates: Array<{ col: string; value: unknown }> = [];
    for (const { col, key } of PROFILE_COLUMNS) {
      const newValue = fill[key];
      if (newValue == null) continue;
      if (existing && existing[col] != null) continue; // never overwrite
      updates.push({ col, value: newValue });
    }
    if (updates.length === 0) continue;
    if (existing) {
      const sets = updates.map((u, i) => `${u.col} = $${i + 2}`).join(", ");
      await client.query(
        `UPDATE driver_payroll_profiles SET ${sets}, updated_at = now() WHERE kfi_id = $1`,
        [d.kfi_id, ...updates.map((u) => u.value)],
      );
    } else {
      const cols = ["kfi_id", ...updates.map((u) => u.col)];
      const params = cols.map((_, i) => `$${i + 1}`);
      await client.query(
        `INSERT INTO driver_payroll_profiles (${cols.join(", ")}) VALUES (${params.join(", ")})
         ON CONFLICT (kfi_id) DO NOTHING`,
        [d.kfi_id, ...updates.map((u) => u.value)],
      );
    }
    result.driversFilled++;
    result.fieldsFilled += updates.length;
  }
  return result;
}
