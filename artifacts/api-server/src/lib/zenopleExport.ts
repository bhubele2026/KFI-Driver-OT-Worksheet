import * as XLSX from "xlsx";
import type { Punch } from "@workspace/db/schema";
import { computeDriverTotals } from "./hoursEngine.js";
import { periodEndFor } from "./time.js";

/**
 * PPE is the app week's Saturday for EVERY customer. The earlier
 * per-customer Sunday shift (Adient/DeLallo/Schuette/WB) matched a May
 * reference, but the PD 07.24 and PD 07.31 files both stamp one uniform
 * Saturday on every row — the Sunday rule is retired (2026-08-05).
 */

/**
 * Customers whose export replaces the RT/OT rows with a shift-differential
 * re-rating pair (see the reference files): per driver,
 *   ShiftDifferential    −X @ RT pay rate  (RT bill rate)
 *   ShiftDifferentialOT  +X @ OT pay rate  (OT bill rate)
 * where X = that driver's DriverRT hours; the normal DriverRT/DriverOT rows
 * still follow. Keyed by the exact Zenople customer label.
 */
export const SHIFT_DIFF_CUSTOMERS = new Set<string>([
  "Shuster's Building Components",
]);

// Exact header strings from the attached Zenople sample
// (Driver_Pay_Units_customer_and_Driver_time_PD_05.15.2026_…xlsx).
// Three of them carry a leading space — preserved verbatim so the file
// is byte-compatible with the sample Zenople's import accepts today.
export const ZENOPLE_HEADER = [
  "Customer",
  "Person",
  "SSN",
  "JobId",
  "PersonId",
  "TransactionCode",
  "Pay Unit",
  "Pay Rate",
  "Bill Unit",
  "Bill Rate",
  "Item Pay",
  "Item Bill",
  "PPE",
  "Start Date",
  " End Date",
  " Status",
  " Assignment Id",
] as const;

export type ZenopleTxnCode =
  | "RT"
  | "OT"
  | "DriverRT"
  | "DriverOT"
  | "ShiftDifferential"
  | "ShiftDifferentialOT";

export interface ZenopleProfile {
  ssn: string | null;
  jobId: number | null;
  personId: number | null;
  assignmentId: number | null;
  zenopleCustomer: string | null;
  rtPayRate: number | null;
  rtBillRate: number | null;
  otPayRate: number | null;
  otBillRate: number | null;
  driverRtPayRate: number | null;
  driverRtBillRate: number | null;
  driverOtPayRate: number | null;
  driverOtBillRate: number | null;
}

export interface ZenopleDriverInput {
  kfiId: string;
  /** Roster name; only used as a fallback if `zenopleName` is empty. */
  name: string;
  /** "LASTNAME, FIRSTNAME" — what Zenople expects in the Person column. */
  zenopleName?: string | null;
  profile: ZenopleProfile;
  punches: Punch[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** "Jose Angulo Alfaro" -> "ANGULO ALFARO, JOSE" (best-effort fallback). */
export function rosterNameToZenople(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.includes(",")) return cleaned.toUpperCase();
  const parts = cleaned.split(" ");
  if (parts.length < 2) return cleaned.toUpperCase();
  const first = parts[0];
  const rest = parts.slice(1).join(" ");
  return `${rest}, ${first}`.toUpperCase();
}

/** ISO YYYY-MM-DD (already a Saturday) -> Excel date serial. */
export function isoToExcelSerial(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  // Days between 1899-12-30 (Excel epoch with leap-bug compat) and the target,
  // computed in UTC so tz never enters the picture.
  const target = Date.UTC(y, m - 1, d);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((target - epoch) / 86_400_000);
}

interface ZenopleRow {
  customer: string;
  person: string;
  ssn: string;
  jobId: number;
  personId: number;
  code: ZenopleTxnCode;
  payUnit: number;
  payRate: number;
  billRate: number;
  ppe: number;
  assignmentId: number;
}

function rateFor(
  profile: ZenopleProfile,
  code: ZenopleTxnCode,
): { pay: number; bill: number } {
  switch (code) {
    // The shift-diff pair re-rates hours at the plain RT/OT rates.
    case "RT":
    case "ShiftDifferential":
      return {
        pay: Number(profile.rtPayRate ?? 0),
        bill: Number(profile.rtBillRate ?? 0),
      };
    case "OT":
    case "ShiftDifferentialOT":
      return {
        pay: Number(profile.otPayRate ?? 0),
        bill: Number(profile.otBillRate ?? 0),
      };
    case "DriverRT":
      return {
        pay: Number(profile.driverRtPayRate ?? 0),
        bill: Number(profile.driverRtBillRate ?? 0),
      };
    case "DriverOT":
      return {
        pay: Number(profile.driverOtPayRate ?? 0),
        bill: Number(profile.driverOtBillRate ?? 0),
      };
  }
}

/**
 * Build the (driver, txn code) rows that will populate the xlsx. Zero-hour
 * buckets are intentionally omitted — see task spec.
 *
 * Sorting: by Zenople customer label (alpha), then by Person (last-name-
 * first, alpha) so it lines up with the sample Zenople expects.
 */
export function buildZenopleRows(
  drivers: ZenopleDriverInput[],
  weekStartIso: string,
): ZenopleRow[] {
  const out: ZenopleRow[] = [];
  // Uniform PPE: the app week's Saturday, for every customer.
  const ppe = isoToExcelSerial(periodEndFor(weekStartIso, 6));
  for (const d of drivers) {
    if (!d.profile) continue;
    const totals = computeDriverTotals(d.punches);
    const customer = d.profile.zenopleCustomer ?? "";
    let buckets: Array<[ZenopleTxnCode, number]>;
    if (SHIFT_DIFF_CUSTOMERS.has(customer)) {
      // Shift-diff customers: no RT/OT rows; the pair re-rates the driver
      // hours (negative at RT, positive at OT), then the driver rows.
      const x = r2(totals.driverRt);
      buckets = x > 0 ? [["ShiftDifferential", -x], ["ShiftDifferentialOT", x]] : [];
      buckets.push(["DriverRT", totals.driverRt], ["DriverOT", totals.driverOt]);
    } else {
      buckets = [
        ["RT", totals.custRt],
        ["OT", totals.custOt],
        ["DriverRT", totals.driverRt],
        ["DriverOT", totals.driverOt],
      ];
    }
    const person =
      (d.zenopleName && d.zenopleName.trim()) || rosterNameToZenople(d.name);
    for (const [code, hoursRaw] of buckets) {
      const hours = r2(hoursRaw);
      // Zero-hour buckets are dropped; the ShiftDifferential row is the one
      // legitimately NEGATIVE bucket and must survive the filter.
      if (hours === 0 || (hours < 0 && code !== "ShiftDifferential")) continue;
      const { pay, bill } = rateFor(d.profile, code);
      out.push({
        customer,
        person,
        ssn: d.profile.ssn ?? "",
        jobId: d.profile.jobId ?? 0,
        personId: d.profile.personId ?? 0,
        code,
        payUnit: hours,
        payRate: pay,
        billRate: bill,
        ppe,
        assignmentId: d.profile.assignmentId ?? 0,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.customer.localeCompare(b.customer) || a.person.localeCompare(b.person),
  );
  return out;
}

/** Serialize rows to the AoA layout the sample uses. */
export function rowsToAoA(rows: ZenopleRow[]): unknown[][] {
  const out: unknown[][] = [ZENOPLE_HEADER.slice()];
  for (const r of rows) {
    // Item Bill quirk: empty string for DriverRT, 0 elsewhere. Documented
    // in the task spec to mirror the sample's behavior.
    const itemBill: number | string = r.code === "DriverRT" ? "" : 0;
    out.push([
      r.customer,
      r.person,
      r.ssn,
      r.jobId,
      r.personId,
      r.code,
      r.payUnit,
      r.payRate,
      0,
      r.billRate,
      0,
      itemBill,
      r.ppe,
      "",
      "",
      "",
      r.assignmentId,
    ]);
  }
  return out;
}

/** Serialize already-built rows to the xlsx buffer Zenople imports. */
export function workbookFromRows(rows: ZenopleRow[]): Buffer {
  const aoa = rowsToAoA(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  // type "buffer" returns a Node Buffer.
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function buildZenopleWorkbook(
  drivers: ZenopleDriverInput[],
  weekStartIso: string,
): Buffer {
  return workbookFromRows(buildZenopleRows(drivers, weekStartIso));
}

/**
 * Snapshot payload persisted at export time (export_snapshots). Strips
 * `ssn` from every row — the snapshot is served to the Master Dash via
 * /pulse and SSNs must never leave this app. Dollar totals are the
 * derived gross the workbook itself never carries (Item Pay/Bill are
 * written as 0 and Zenople computes them): payUnit × rate, summed. The
 * ShiftDifferential row's negative payUnit nets out by construction.
 */
export function buildExportSnapshot(rows: ZenopleRow[]): {
  rows: Array<Omit<ZenopleRow, "ssn">>;
  totals: {
    byCode: Record<string, { hours: number; pay: number; bill: number }>;
    byCustomer: Record<string, { hours: number; pay: number; bill: number }>;
    hours: number;
    pay: number;
    bill: number;
  };
  rowCount: number;
  driverCount: number;
} {
  const byCode: Record<string, { hours: number; pay: number; bill: number }> = {};
  // Per-Zenople-customer totals: the Master Dash reconciles exported hours
  // against fact_markup, which is keyed by Organization — the customer set
  // here is what scopes that query to driver work only.
  const byCustomer: Record<string, { hours: number; pay: number; bill: number }> = {};
  let hours = 0;
  let pay = 0;
  let bill = 0;
  const persons = new Set<string>();
  const stripped: Array<Omit<ZenopleRow, "ssn">> = [];
  for (const r of rows) {
    const { ssn: _ssn, ...rest } = r;
    stripped.push(rest);
    persons.add(`${r.personId}|${r.person}`);
    const rowPay = r.payUnit * r.payRate;
    const rowBill = r.payUnit * r.billRate;
    for (const b of [(byCode[r.code] ??= { hours: 0, pay: 0, bill: 0 }), (byCustomer[r.customer] ??= { hours: 0, pay: 0, bill: 0 })]) {
      b.hours = r2(b.hours + r.payUnit);
      b.pay = r2(b.pay + rowPay);
      b.bill = r2(b.bill + rowBill);
    }
    hours = r2(hours + r.payUnit);
    pay = r2(pay + rowPay);
    bill = r2(bill + rowBill);
  }
  return {
    rows: stripped,
    totals: { byCode, byCustomer, hours, pay, bill },
    rowCount: rows.length,
    driverCount: persons.size,
  };
}

/**
 * Build the file name the dispatcher downloads. Format mirrors the sample:
 *   Driver_Pay_Units_customer_and_Driver_time_PD_<MM.DD.YYYY>_<PPE>.xlsx
 * `pdDate` is today (the print date); `weekEndIso` is the Saturday.
 */
export function zenopleFileName(pdDate: Date, weekEndIso: string): string {
  const mm = String(pdDate.getMonth() + 1).padStart(2, "0");
  const dd = String(pdDate.getDate()).padStart(2, "0");
  const yyyy = pdDate.getFullYear();
  const ppe = isoToExcelSerial(weekEndIso);
  return `Driver_Pay_Units_customer_and_Driver_time_PD_${mm}.${dd}.${yyyy}_${ppe}.xlsx`;
}

/**
 * Profile fields required for a driver to be eligible for export.
 *
 * Only the five **identity** fields block readiness — they're the keys
 * that route the payroll line to the correct Zenople record, so
 * missing them would silently send hours to the wrong assignment.
 *
 * Pay/bill rate fields are deliberately not checked: a missing rate
 * is treated the same as `$0` and written as numeric `0` in the
 * exported workbook (see `rateFor` which coerces `null` → `0`). This
 * matches the dispatcher workflow where many drivers legitimately
 * have $0 in some rate buckets (no OT bill arrangement, salaried,
 * etc.) and shouldn't be forced to type "0.00" into eight cells just
 * to clear the readiness warning.
 */
export const IDENTITY_PROFILE_FIELDS = [
  "ssn",
  "jobId",
  "personId",
  "assignmentId",
  "zenopleCustomer",
] as const;

/**
 * Field-wise merge: live Zenople facts win, the stored profile fills the
 * gaps. Zenople is the system of record for this workbook (it gets imported
 * back INTO Zenople), and its rates / bill rates / JobId / AssignmentId
 * drift week to week — a stored profile is only the fallback for people the
 * live fetch can't see (or when the API is down).
 */
export interface ZenopleLiveOverlay {
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

export function mergeProfileWithLive(
  profile: ZenopleProfile,
  live: ZenopleLiveOverlay | null | undefined,
): ZenopleProfile {
  if (!live) return profile;
  return {
    ssn: live.ssn ?? profile.ssn,
    jobId: live.jobId ?? profile.jobId,
    personId: live.personId ?? profile.personId,
    assignmentId: live.assignmentId ?? profile.assignmentId,
    zenopleCustomer: live.zenopleCustomer ?? profile.zenopleCustomer,
    rtPayRate: live.rtPayRate ?? profile.rtPayRate,
    rtBillRate: live.rtBillRate ?? profile.rtBillRate,
    otPayRate: live.otPayRate ?? profile.otPayRate,
    otBillRate: live.otBillRate ?? profile.otBillRate,
    driverRtPayRate: live.driverRtPayRate ?? profile.driverRtPayRate,
    driverRtBillRate: live.driverRtBillRate ?? profile.driverRtBillRate,
    driverOtPayRate: live.driverOtPayRate ?? profile.driverOtPayRate,
    driverOtBillRate: live.driverOtBillRate ?? profile.driverOtBillRate,
  };
}

export function missingProfileFields(profile: ZenopleProfile | null): string[] {
  if (!profile) return [...IDENTITY_PROFILE_FIELDS];
  const missing: string[] = [];
  if (!profile.ssn) missing.push("ssn");
  if (profile.jobId == null) missing.push("jobId");
  if (profile.personId == null) missing.push("personId");
  if (profile.assignmentId == null) missing.push("assignmentId");
  if (!profile.zenopleCustomer) missing.push("zenopleCustomer");
  return missing;
}
