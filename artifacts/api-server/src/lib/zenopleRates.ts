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
import { zenopleLiveIdentityEnabled } from "./zenopleExport.js";
import { pullRange, zenopleConfigured } from "./zenopleClient.js";

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

// The client is VENDORED at ./zenopleClient.ts (canonical copy lives in
// KFI-Financial-Dashboard/packages/zenople). It owns the queue, the 55/min +
// 900/hr limiter, exponential backoff honoring Retry-After, the same-payload
// cooldown and the one cached token (only 20 token requests/hr are allowed).
export { zenopleConfigured, zenopleStats } from "./zenopleClient.js";

/**
 * Pull an action over the last `days`, in sequential 30-day chunks.
 *
 * This replaces a ladder that re-sent the SAME action at 365 → 180 → 90 → 45 →
 * 21 days with no delay between attempts until one came back small enough —
 * the exact "do not immediately retry identical requests" anti-pattern the
 * vendor's same-payload cooldown now blocks. Chunking asks for reasonable
 * ranges to begin with, so nothing has to fail first.
 */
async function fetchAction(action: string, days = 365, opts: { cacheTtlMs?: number; force?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const { rows, skipped } = await pullRange<Record<string, unknown>>(action, start, end, {
    chunkDays: 30,
    ...opts,
  });
  if (skipped.length) {
    // Never silently short — the caller is filling payroll rates from this.
    console.warn(`Zenople ${action}: ${skipped.length} slice(s) unpullable, result is INCOMPLETE`, skipped);
  }
  return rows;
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
  /** "LASTNAME, FIRST" from the identity assignment (reference style). */
  personLabel?: string;
  rtPayRate?: number;
  rtBillRate?: number;
  otPayRate?: number;
  otBillRate?: number;
  driverRtPayRate?: number;
  driverRtBillRate?: number;
  driverOtPayRate?: number;
  driverOtBillRate?: number;
  /**
   * Where each resolved rate came from. Not a DB column — the profile card
   * reads it so a dispatcher can tell a live Zenople rate from a derived one
   * from a hand-saved fallback.
   */
  sources?: Record<string, RateSource>;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);
const round2 = (v: number) => Math.round(Number((v * 100).toFixed(6))) / 100;
const isDriverLane = (jobPosition: unknown) => /driver/i.test(String(jobPosition ?? ""));

function maskSsn(raw: unknown): string | undefined {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 4) return undefined;
  return `XXX-XX-${digits.slice(-4)}`;
}

/**
 * The payroll week an export is being built for. Rates must resolve as-of this
 * window, never as-of today: `IsActiveToday` is a fact about the moment the
 * admin clicked the button, not about the week being paid.
 */
export interface RateWeek {
  /** Canonical Sunday, `YYYY-MM-DD`. */
  start: string;
  /** Saturday, `YYYY-MM-DD`. */
  end: string;
}

/** Where a resolved rate actually came from — surfaced to the profile card. */
export type RateSource = "assignment" | "actuals" | "derived";

const isoDay = (v: unknown): string => String(v ?? "").slice(0, 10);

/**
 * Zenople leaves EndDate empty on an open assignment, and sets it equal to
 * StartDate on some inactive ones — both are handled by plain string compare
 * because every date arrives as ISO `YYYY-MM-DD...`.
 */
function overlapsWeek(a: Record<string, unknown>, week: RateWeek): boolean {
  const start = isoDay(a.StartDate);
  const end = isoDay(a.EndDate);
  if (start && start > week.end) return false; // began after the week closed
  if (end && end < week.start) return false; // ended before the week opened
  return true;
}

const rankAssignments = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => {
    const activeA = a.IsActiveToday === true ? 1 : 0;
    const activeB = b.IsActiveToday === true ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    return String(b.StartDate ?? "").localeCompare(String(a.StartDate ?? ""));
  })[0];

/**
 * The assignment in force for `week` — or, with no week, the old behaviour
 * (latest, preferring active today).
 *
 * ⚠️ This is the Tijerina defect. He held Orgill (started 6/23) and Landscape
 * Structures (started 8/13); ranking by latest StartDate let an assignment
 * created the DAY OF the export hijack a week that had closed before it
 * existed. Filtering to assignments that overlap the week fixes that class
 * outright.
 *
 * The ladder never returns undefined for a non-empty list: a dropped
 * assignment means a $0 rate silently riding onto the workbook, which is
 * exactly what went out on 2026-08-06.
 */
function pickAssignment(
  rows: Record<string, unknown>[],
  week?: RateWeek,
): Record<string, unknown> | undefined {
  if (!rows.length) return undefined;
  if (!week) return rankAssignments(rows);
  const during = rows.filter((a) => overlapsWeek(a, week));
  if (during.length) {
    // They all cover the week, so "latest today" is meaningless here — the
    // one that started most recently is the one in force.
    return [...during].sort((a, b) =>
      String(b.StartDate ?? "").localeCompare(String(a.StartDate ?? "")),
    )[0];
  }
  const before = rows.filter((a) => {
    const s = isoDay(a.StartDate);
    return s !== "" && s <= week.end;
  });
  return rankAssignments(before.length ? before : rows);
}

/**
 * Effective $/hr for one pay/bill component.
 *
 * With a `week`, this is the most recent CLOSED pay period on or before it
 * that actually carries hours — NOT a blend. Averaging a year of transactions
 * averages across every raise the person ever had: that is what shipped Baez's
 * OT at 32.55 when Zenople had been paying him 32.90 for twelve straight
 * periods, and Medina's at 30.27 against a true 31.50.
 */
function effectiveRate(
  rows: Record<string, unknown>[],
  amountKey: string,
  hoursKey: string,
  week?: RateWeek,
): number | undefined {
  const blend = (list: Record<string, unknown>[]) => {
    let amount = 0;
    let hours = 0;
    for (const r of list) {
      amount += num(r[amountKey]);
      hours += num(r[hoursKey]);
    }
    return hours < 0.5 ? undefined : round2(amount / hours);
  };
  if (!week) return blend(rows);
  const byPeriod = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const ppe = isoDay(r.PayPeriodEndDate);
    if (!ppe || ppe > week.end) continue;
    (byPeriod.get(ppe) ?? byPeriod.set(ppe, []).get(ppe)!).push(r);
  }
  for (const ppe of [...byPeriod.keys()].sort().reverse()) {
    const rate = blend(byPeriod.get(ppe)!);
    if (rate != null) return rate;
  }
  return undefined;
}

export function computeProfileFill(
  assignments: Record<string, unknown>[],
  transactions: Record<string, unknown>[],
  week?: RateWeek,
): ProfileFill {
  const fill: ProfileFill = {};
  const sources: Record<string, RateSource> = {};
  const driverRows = assignments.filter((a) => isDriverLane(a.JobPosition));
  const customerRows = assignments.filter((a) => !isDriverLane(a.JobPosition));
  const driverAsg = pickAssignment(driverRows, week);
  const customerAsg = pickAssignment(customerRows, week);
  const driverTx = transactions.filter((t) => isDriverLane(t.JobPosition));
  const customerTx = transactions.filter((t) => !isDriverLane(t.JobPosition));

  /**
   * The rate ladder, in this order on purpose:
   *   1. the assignment in force that week — the rate, when Zenople carries one
   *   2. what Zenople actually PAID around that week — reality beats a stale row
   *   3. any assignment that carries a rate at all — last resort
   *
   * Step 3 exists only so a rate can never come back $0: week-scoping must not
   * cost us a number we would otherwise have had, which is how seven drivers
   * shipped at $0 on 2026-08-06. It sits BELOW actuals so a long-ended
   * assignment can never outrank what the person is currently being paid.
   */
  const rateFrom = (
    scoped: Record<string, unknown> | undefined,
    all: Record<string, unknown>[],
    key: "PayRate" | "BillRate",
    txRows: Record<string, unknown>[],
    amountKey: string,
    hoursKey: string,
  ): { value?: number; source?: RateSource } => {
    if (scoped && num(scoped[key]) > 0) {
      return { value: round2(num(scoped[key])), source: "assignment" };
    }
    const actual = effectiveRate(txRows, amountKey, hoursKey, week);
    if (actual != null) return { value: actual, source: "actuals" };
    const anyRated = pickAssignment(
      all.filter((a) => num(a[key]) > 0),
      week,
    );
    if (anyRated) return { value: round2(num(anyRated[key])), source: "assignment" };
    return {};
  };
  const apply = (
    field: "rtPayRate" | "rtBillRate" | "driverRtPayRate" | "driverRtBillRate",
    r: { value?: number; source?: RateSource },
  ) => {
    if (r.value == null || r.source == null) return;
    fill[field] = r.value;
    sources[field] = r.source;
  };

  // ⚠️ PRECEDENCE: the assignment rate IS the rate; actuals are a fallback for
  // when Zenople carries no rate on the assignment (PayRate 0), never an
  // override. OT pay is 1.5 × RT whenever RT came from an assignment —
  // verified against Zenople's own paid actuals for Baez (21.93 → 32.90) and
  // Medina (21.00 → 31.50), exact to the cent across every recent period.
  apply("rtPayRate", rateFrom(customerAsg, customerRows, "PayRate", customerTx, "RTPay", "RTPayHours"));
  apply("rtBillRate", rateFrom(customerAsg, customerRows, "BillRate", customerTx, "RTBill", "RTBillHours"));

  const half = (base: number | undefined) => (base != null ? round2(base * 1.5) : undefined);
  const pick = (
    field: "otPayRate" | "otBillRate",
    baseSource: RateSource | undefined,
    derived: number | undefined,
    actual: number | undefined,
  ) => {
    // A derived rate is only trustworthy when its base was, so actuals still
    // win for a person whose assignment carries no rate at all.
    const useDerived = baseSource === "assignment" && derived != null;
    const value = useDerived ? derived : (actual ?? derived);
    if (value == null) return;
    fill[field] = value;
    sources[field] = useDerived || actual == null ? "derived" : "actuals";
  };
  pick(
    "otPayRate",
    sources.rtPayRate,
    half(fill.rtPayRate),
    effectiveRate(customerTx, "OTPay", "OTPayHours", week),
  );
  pick(
    "otBillRate",
    sources.rtBillRate,
    half(fill.rtBillRate),
    effectiveRate(customerTx, "OTBill", "OTBillHours", week),
  );

  // Driver lane — same shape. A 0 assignment PayRate means "unrated in
  // AssignmentData" (Disla's $16 only shows in his transactions), so fall
  // through to actuals; a 0 BillRate is REAL though — driver time is billed
  // at $0 in Zenople.
  apply("driverRtPayRate", rateFrom(driverAsg, driverRows, "PayRate", driverTx, "RTPay", "RTPayHours"));
  if (driverAsg) {
    fill.driverRtBillRate = round2(num(driverAsg.BillRate));
    sources.driverRtBillRate = "assignment";
  } else {
    const rtBill = effectiveRate(driverTx, "RTBill", "RTBillHours", week);
    if (rtBill != null) {
      fill.driverRtBillRate = rtBill;
      sources.driverRtBillRate = "actuals";
    }
  }
  // Driver OT is computed on the person's overall RT rate (seed data:
  // driver $10/hr people carry driverOt = 1.5 × their customer RT).
  const otBase = fill.rtPayRate ?? fill.driverRtPayRate;
  const otBaseSource = fill.rtPayRate != null ? sources.rtPayRate : sources.driverRtPayRate;
  const derivedDriverOt =
    fill.driverRtPayRate != null && otBase != null ? round2(otBase * 1.5) : undefined;
  const dOtPay = effectiveRate(driverTx, "OTPay", "OTPayHours", week);
  if (otBaseSource === "assignment" && derivedDriverOt != null) {
    fill.driverOtPayRate = derivedDriverOt;
    sources.driverOtPayRate = "derived";
  } else if (dOtPay != null) {
    fill.driverOtPayRate = dOtPay;
    sources.driverOtPayRate = "actuals";
  } else if (derivedDriverOt != null) {
    fill.driverOtPayRate = derivedDriverOt;
    sources.driverOtPayRate = "derived";
  }
  const dOtBill = effectiveRate(driverTx, "OTBill", "OTBillHours", week);
  if (dOtBill != null) {
    fill.driverOtBillRate = dOtBill;
    sources.driverOtBillRate = "actuals";
  } else if (fill.driverRtBillRate === 0) {
    fill.driverOtBillRate = 0;
    sources.driverOtBillRate = "derived";
  }

  // Identifiers — the reference workbook stamps ONE assignment per person
  // on every row: the ACTIVE customer assignment when there is one (Baez →
  // 559/2541, not his driver 483/2523), else the active driver assignment
  // (Disla → 3418, not his ended IWG customer role), else whatever exists.
  const isActive = (a: Record<string, unknown> | undefined) =>
    a != null && (week ? overlapsWeek(a, week) : a.IsActiveToday === true);
  const idAsg =
    [customerAsg, driverAsg].find(isActive) ?? customerAsg ?? driverAsg;
  if (idAsg) {
    const ssn = maskSsn(idAsg.SSN);
    if (ssn) fill.ssn = ssn;
    if (num(idAsg.JobId) > 0) fill.jobId = num(idAsg.JobId);
    if (num(idAsg.PersonId) > 0) fill.personId = num(idAsg.PersonId);
    if (num(idAsg.AssignmentId) > 0) fill.assignmentId = num(idAsg.AssignmentId);
    const org = String(idAsg.Organization ?? "").trim();
    if (org) fill.zenopleCustomer = org;
    const label = personLabelFromAssignment(idAsg);
    if (label) fill.personLabel = label;
  }

  fill.sources = sources;
  return fill;
}

// ---------------------------------------------------------------------------
// Export-time live facts (Zenople is the system of record for the weekly
// Driver_Pay_Units workbook: rates, bill rates, JobId and AssignmentId all
// drift week to week in Zenople, so the export pulls them fresh instead of
// trusting the stored profile — the profile is the fallback/override).
// ---------------------------------------------------------------------------

export type ZenopleLiveFacts = ProfileFill;

function personLabelFromAssignment(a: Record<string, unknown>): string | undefined {
  // Reference style: "LASTNAME, FIRST" uppercased, generational suffixes
  // dropped ("MEDINA, WILLIE" — not "MEDINA JR, WILLIE"), whitespace
  // collapsed.
  const clean = (s: unknown) =>
    String(s ?? "")
      .replace(/\b(JR|SR|II|III|IV)\.?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  const last = clean(a.LastName);
  const first = clean(a.FirstName);
  if (!last || !first) return undefined;
  return `${last}, ${first}`.toUpperCase();
}

/**
 * Per-PersonId live facts for the Zenople export. Empty map when not configured.
 *
 * Cached for ten minutes: this is a per-request pull behind an admin button
 * with no rate limit on it, and a failure is swallowed by the caller (the
 * export falls back to stored profiles), so an unlucky admin used to just click
 * again — each click costing two Zenople pulls. `fresh` skips the memo for the
 * case where someone has just corrected a rate in Zenople and needs to see it.
 */
const EXPORT_FACTS_TTL_MS = 10 * 60 * 1000;

export async function loadZenopleExportFacts(
  opts_: { week?: RateWeek; fresh?: boolean } = {},
): Promise<Map<string, ZenopleLiveFacts>> {
  const { week, fresh = false } = opts_;
  const out = new Map<string, ZenopleLiveFacts>();
  if (!zenopleConfigured()) return out;
  const opts = { cacheTtlMs: EXPORT_FACTS_TTL_MS, force: fresh };
  const [assignments, transactions] = await Promise.all([
    fetchAction("AssignmentData", 365, opts),
    fetchAction("TransactionData", 365, opts),
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
  const pids = new Set([...asgByPerson.keys(), ...txByPerson.keys()]);
  for (const pid of pids) {
    out.set(
      pid,
      computeProfileFill(asgByPerson.get(pid) ?? [], txByPerson.get(pid) ?? [], week),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boot backfill
// ---------------------------------------------------------------------------

/**
 * The five columns that say WHO this driver is and WHERE they work. The
 * backfill only writes these when live identity is re-enabled — writing them
 * from a name-fingerprint guess is what attached a stranger's PersonId, SSN
 * and customer to a real driver. See `zenopleLiveIdentityEnabled`.
 */
const IDENTITY_COLUMNS: Array<{ col: string; key: keyof ProfileFill }> = [
  { col: "ssn", key: "ssn" },
  { col: "job_id", key: "jobId" },
  { col: "person_id", key: "personId" },
  { col: "assignment_id", key: "assignmentId" },
  { col: "zenople_customer", key: "zenopleCustomer" },
];

const RATE_COLUMNS: Array<{ col: string; key: keyof ProfileFill }> = [
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
  /** Name matched >1 Zenople person — refused rather than guessing. */
  ambiguousNames: string[];
  /** False when identity columns were left alone (the default). */
  identityWritten: boolean;
}

/**
 * fingerprint -> every distinct Zenople PersonId carrying that name.
 *
 * The old map kept the FIRST person per fingerprint and silently dropped the
 * rest, so a driver could inherit a same-named stranger's identity. Callers
 * must treat a >1 result as unresolved.
 */
export function indexPersonIdsByName(
  assignments: Record<string, unknown>[],
): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const a of assignments) {
    const fp = fingerprintName(
      `${a.LastName ?? ""}, ${a.FirstName ?? ""} ${a.MiddleName ?? ""}`,
    );
    const pid = String(a.PersonId ?? "");
    if (!fp || !pid) continue;
    (m.get(fp) ?? m.set(fp, new Set()).get(fp)!).add(pid);
  }
  return new Map([...m].map(([k, v]) => [k, [...v]]));
}

/**
 * Fill NULL payroll-profile fields for active drivers from Zenople. Matches
 * by PersonId == kfi_id first (real badge ids ARE Zenople person ids), then
 * by name fingerprint — but only when that name resolves to exactly ONE
 * Zenople person. Internal/test roster rows (customer starting "zz") are
 * skipped — they are not payroll drivers.
 *
 * Writes RATE columns only. The five identity columns are the dispatcher's
 * unless ZENOPLE_LIVE_IDENTITY=1; see `zenopleLiveIdentityEnabled`.
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
    ambiguousNames: [],
    identityWritten: zenopleLiveIdentityEnabled(),
  };
  if (!zenopleConfigured()) {
    result.skipped = true;
    return result;
  }
  // Rates always; identity only when live identity is explicitly re-enabled.
  const columns = result.identityWritten
    ? [...IDENTITY_COLUMNS, ...RATE_COLUMNS]
    : RATE_COLUMNS;

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
  // Only usable when the name resolves to exactly one Zenople person.
  const personIdsByFp = indexPersonIdsByName(assignments);

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
    if (!pid) {
      const candidates = personIdsByFp.get(fingerprintName(d.name)) ?? [];
      if (candidates.length > 1) {
        // Two humans share this name. Refuse — guessing here is what put a
        // stranger's PersonId on a real driver's payroll rows.
        result.ambiguousNames.push(
          `${d.name} (${d.kfi_id}) -> ${candidates.join(", ")}`,
        );
        continue;
      }
      pid = candidates[0] ?? null;
    }
    if (!pid || (!asgByPerson.has(pid) && !txByPerson.has(pid))) {
      result.noZenopleMatch.push(`${d.name} (${d.kfi_id})`);
      continue;
    }
    const fill = computeProfileFill(asgByPerson.get(pid) ?? [], txByPerson.get(pid) ?? []);
    const existing = profileByKfi.get(d.kfi_id);
    const updates: Array<{ col: string; value: unknown }> = [];
    for (const { col, key } of columns) {
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
