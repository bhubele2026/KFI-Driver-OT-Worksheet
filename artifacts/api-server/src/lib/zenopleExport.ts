import * as XLSX from "xlsx";
import type { Punch } from "@workspace/db/schema";
import { computeDriverTotals } from "./hoursEngine.js";

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

export type ZenopleTxnCode = "RT" | "OT" | "DriverRT" | "DriverOT";

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
    case "RT":
      return {
        pay: Number(profile.rtPayRate ?? 0),
        bill: Number(profile.rtBillRate ?? 0),
      };
    case "OT":
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
  weekEndIso: string,
): ZenopleRow[] {
  const ppe = isoToExcelSerial(weekEndIso);
  const out: ZenopleRow[] = [];
  for (const d of drivers) {
    if (!d.profile) continue;
    const totals = computeDriverTotals(d.punches);
    const buckets: Array<[ZenopleTxnCode, number]> = [
      ["RT", totals.custRt],
      ["OT", totals.custOt],
      ["DriverRT", totals.driverRt],
      ["DriverOT", totals.driverOt],
    ];
    const person =
      (d.zenopleName && d.zenopleName.trim()) || rosterNameToZenople(d.name);
    const customer = d.profile.zenopleCustomer ?? "";
    for (const [code, hoursRaw] of buckets) {
      const hours = r2(hoursRaw);
      if (hours <= 0) continue;
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

export function buildZenopleWorkbook(
  drivers: ZenopleDriverInput[],
  weekEndIso: string,
): Buffer {
  const rows = buildZenopleRows(drivers, weekEndIso);
  const aoa = rowsToAoA(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  // type "buffer" returns a Node Buffer.
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
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

/** Profile fields required for a driver to be eligible for export. */
export function missingProfileFields(profile: ZenopleProfile | null): string[] {
  if (!profile) {
    return [
      "ssn",
      "jobId",
      "personId",
      "assignmentId",
      "zenopleCustomer",
      "rtPayRate",
      "rtBillRate",
      "otPayRate",
      "otBillRate",
      "driverRtPayRate",
      "driverRtBillRate",
      "driverOtPayRate",
      "driverOtBillRate",
    ];
  }
  const missing: string[] = [];
  if (!profile.ssn) missing.push("ssn");
  if (profile.jobId == null) missing.push("jobId");
  if (profile.personId == null) missing.push("personId");
  if (profile.assignmentId == null) missing.push("assignmentId");
  if (!profile.zenopleCustomer) missing.push("zenopleCustomer");
  if (profile.rtPayRate == null) missing.push("rtPayRate");
  if (profile.rtBillRate == null) missing.push("rtBillRate");
  if (profile.otPayRate == null) missing.push("otPayRate");
  if (profile.otBillRate == null) missing.push("otBillRate");
  if (profile.driverRtPayRate == null) missing.push("driverRtPayRate");
  if (profile.driverRtBillRate == null) missing.push("driverRtBillRate");
  if (profile.driverOtPayRate == null) missing.push("driverOtPayRate");
  if (profile.driverOtBillRate == null) missing.push("driverOtBillRate");
  return missing;
}
