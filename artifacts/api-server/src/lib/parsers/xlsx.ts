import * as XLSX from "xlsx";
import { fmtDate, fmtDT } from "../time.js";
import { EMBEDDED_MAPPING } from "../mappings.js";
import type { ParsedPunch, UnmappedIdAccumulator } from "./types.js";

type IdMap = Record<string, string>;

type Row = unknown[];

function sheetRows(wb: XLSX.WorkBook, sheetName?: string): Row[] {
  const ws = wb.Sheets[sheetName ?? wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, defval: null });
}

function findHeader(hdr: Row, predicate: (s: string) => boolean): number {
  return hdr.findIndex((h) => h != null && predicate(String(h).toLowerCase()));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function parseTime12(date: string, timeStr: string): Date {
  const d = new Date(`${date} ${timeStr}`);
  return isNaN(d.getTime()) ? new Date(NaN) : d;
}

export function parsePendaTrienda(
  wb: XLSX.WorkBook,
  customer: "Penda" | "Trienda",
  kfiSet: Set<string>,
  unmappedIds: UnmappedIdAccumulator,
  idMap: IdMap = EMBEDDED_MAPPING,
): ParsedPunch[] {
  const rows = sheetRows(wb);
  const hdr = rows[0];
  if (!hdr) return [];
  const empNumIdx = findHeader(hdr, (s) => s.includes("employee number"));
  const startIdx = findHeader(hdr, (s) => s.includes("time start"));
  const endIdx = findHeader(hdr, (s) => s.includes("time end"));
  const hoursIdx = findHeader(hdr, (s) => s === "hours");
  const payIdx = findHeader(hdr, (s) => s.includes("pay category"));
  const dateIdx = findHeader(hdr, (s) => s === "date");
  if (empNumIdx < 0 || startIdx < 0 || endIdx < 0) return [];

  const shiftMap = new Map<string, ParsedPunch>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[empNumIdx] == null) continue;
    const empId = String(Math.round(Number(r[empNumIdx])));
    const mapped = idMap[empId] ?? (kfiSet.has(empId) ? empId : "");
    const kfiId = mapped && kfiSet.has(mapped) ? mapped : "";
    if (!kfiId) {
      if (/^\d+$/.test(empId)) unmappedIds.add(empId);
      continue;
    }
    if (r[startIdx] == null || r[endIdx] == null) continue;
    const hours = parseFloat(String(r[hoursIdx] ?? "0")) || 0;
    const payType = String(r[payIdx] ?? "Reg");
    if (payType.toUpperCase().includes("SHIFT PREM")) continue;
    const date = r[dateIdx] != null ? fmtDate(r[dateIdx]) : "";
    const clockIn = fmtDT(r[startIdx]);
    const clockOut = fmtDT(r[endIdx]);
    const key = `${kfiId}|${clockIn}|${clockOut}`;
    const existing = shiftMap.get(key);
    if (existing) {
      existing.hours = round3(existing.hours + hours);
      if (payType.includes("OT")) existing.payType = "OT";
    } else {
      shiftMap.set(key, {
        kfiId,
        customer,
        date,
        clockIn,
        clockOut,
        hours: round3(hours),
        payType: payType.includes("OT") ? "OT" : "Reg",
      });
    }
  }
  return [...shiftMap.values()];
}

export function parseGreystone(
  wb: XLSX.WorkBook,
  kfiSet: Set<string>,
  unmappedIds: UnmappedIdAccumulator,
): ParsedPunch[] {
  const rows = sheetRows(wb);
  const hdr = rows[0];
  if (!hdr) return [];
  // Greystone changed columns mid-2026: legacy export had "File Number" /
  // "Pay Date"; new ADP export uses "Person ID" and a per-week column called
  // e.g. "Week 4/26/26 - 5/2/26" that holds the actual ISO date per row.
  const fnIdx = findHeader(
    hdr,
    (s) => s.includes("person id") || s.includes("file number"),
  );
  const dtIdx = findHeader(
    hdr,
    (s) => s.includes("pay date") || s.startsWith("week "),
  );
  const inIdx = findHeader(hdr, (s) => s === "time in");
  const outIdx = findHeader(hdr, (s) => s === "time out");
  const hrIdx = findHeader(hdr, (s) => s === "hours");
  if (fnIdx < 0 || inIdx < 0 || outIdx < 0) {
    throw new Error(
      "Greystone parser: expected columns not found (need Person ID/File Number, Time In, Time Out)",
    );
  }
  const out: ParsedPunch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[fnIdx] == null) continue;
    const kfiId = String(Math.round(Number(r[fnIdx])));
    if (!kfiSet.has(kfiId)) {
      if (/^\d+$/.test(kfiId)) unmappedIds.add(kfiId);
      continue;
    }
    if (r[inIdx] == null || r[outIdx] == null) continue;
    const date = r[dtIdx] != null ? fmtDate(r[dtIdx]) : "";
    out.push({
      kfiId,
      customer: "Greystone",
      date,
      clockIn: `${date} ${r[inIdx]}`,
      clockOut: `${date} ${r[outIdx]}`,
      hours: round3(parseFloat(String(r[hrIdx] ?? "0")) || 0),
      payType: "Reg",
    });
  }
  return out;
}

/**
 * Adient switched from a digital PDF (handled by `parseAdientPDF`) to a
 * Kronos/Workforce-Central XLSX pivot export. The sheet is one big block per
 * employee:
 *   - "Employee Name" header row, with "LASTNAME, FIRST (TELDxxx)" in col 21
 *   - "Job" / "Location" row
 *   - "Transaction Apply Date" row (the actual column header for txns)
 *   - 1..N transaction rows: date in col 0, type in col 8, hours in col 19,
 *     start datetime in col 29, end datetime in col 31.
 * We only keep "Worked Shift Segment" rows (skipping absences, paycode edits).
 */
export function parseAdientXLSX(
  wb: XLSX.WorkBook,
  kfiSet: Set<string>,
  unmappedIds: UnmappedIdAccumulator,
  idMap: IdMap = EMBEDDED_MAPPING,
): ParsedPunch[] {
  const rows = sheetRows(wb);
  const out: ParsedPunch[] = [];
  let kfiId: string | null = null;
  // Column layout is fixed in the Kronos export but we still tolerate a small
  // amount of column drift by re-detecting indices on each header row.
  let dateCol = 0;
  let typeCol = 8;
  let hoursCol = 19;
  let startCol = 29;
  let endCol = 31;
  let sawTxnHeader = false;
  const norm = (v: unknown) =>
    v == null ? "" : String(v).trim().toLowerCase().replace(/\s+/g, " ");
  const findCol = (r: unknown[], wanted: string) =>
    r.findIndex((c) => norm(c) === wanted);
  for (const r of rows) {
    if (norm(r[0]) === "employee name") {
      // Find TELD code anywhere on the row.
      kfiId = null;
      for (const cell of r) {
        if (cell == null) continue;
        const raw = String(cell);
        const m = raw.match(/^(.*?)\s*\((TELD\d+)\)/);
        if (m) {
          const sampleName = m[1].trim() || null;
          kfiId = idMap[m[2]] ?? null;
          if (!kfiId || !kfiSet.has(kfiId)) unmappedIds.add(m[2], sampleName);
          break;
        }
        const bareTeld = raw.match(/\((TELD\d+)\)/);
        if (bareTeld) {
          kfiId = idMap[bareTeld[1]] ?? null;
          if (!kfiId || !kfiSet.has(kfiId)) unmappedIds.add(bareTeld[1]);
          break;
        }
      }
      continue;
    }
    if (norm(r[0]) === "transaction apply date") {
      dateCol = findCol(r, "transaction apply date");
      typeCol = findCol(r, "transaction type");
      hoursCol = findCol(r, "hours");
      startCol = findCol(r, "transaction start date/time");
      endCol = findCol(r, "transaction end date/time");
      if (
        dateCol < 0 ||
        typeCol < 0 ||
        hoursCol < 0 ||
        startCol < 0 ||
        endCol < 0
      ) {
        throw new Error(
          "Adient parser: transaction header is missing one of: Transaction Apply Date, Transaction Type, Hours, Transaction Start Date/Time, Transaction End Date/Time",
        );
      }
      sawTxnHeader = true;
      continue;
    }
    if (!sawTxnHeader || !kfiId || !kfiSet.has(kfiId)) continue;
    if (norm(r[typeCol]) !== "worked shift segment") continue;
    if (r[startCol] == null || r[endCol] == null) continue;
    const hours = parseFloat(String(r[hoursCol] ?? "0")) || 0;
    if (hours <= 0) continue;
    out.push({
      kfiId,
      customer: "Adient",
      date: fmtDate(r[dateCol]),
      clockIn: fmtDT(r[startCol]),
      clockOut: fmtDT(r[endCol]),
      hours: round3(hours),
      payType: "Reg",
    });
  }
  if (!sawTxnHeader) {
    throw new Error(
      "Adient parser: no 'Transaction Apply Date' header found — file format may have changed",
    );
  }
  return out;
}

export function parseLSI(
  wb: XLSX.WorkBook,
  kfiSet: Set<string>,
  unmappedIds: UnmappedIdAccumulator,
  idMap: IdMap = EMBEDDED_MAPPING,
): ParsedPunch[] {
  const rows = sheetRows(wb);
  const hdr = rows[0];
  if (!hdr) return [];
  const posIdx = findHeader(hdr, (s) => s.includes("position"));
  const inIdx = findHeader(hdr, (s) => s === "in time");
  const outIdx = findHeader(hdr, (s) => s === "out time");
  const hrIdx = findHeader(hdr, (s) => s === "hours");
  const dtIdx = findHeader(hdr, (s) => s === "pay date");
  if (posIdx < 0) return [];
  const out: ParsedPunch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[posIdx] == null) continue;
    const posId = String(r[posIdx]).trim();
    if (posId.includes("Total")) continue;
    const mapped = idMap[posId] ?? idMap[posId + "N"] ?? "";
    const kfiId = mapped && kfiSet.has(mapped) ? mapped : "";
    if (!kfiId) {
      if (posId) unmappedIds.add(posId);
      continue;
    }
    if (r[inIdx] == null || r[outIdx] == null) continue;
    const hours = parseFloat(String(r[hrIdx] ?? "0")) || 0;
    if (hours === 0) continue;
    out.push({
      kfiId,
      customer: "Landscape Structures",
      date: r[dtIdx] != null ? fmtDate(r[dtIdx]) : "",
      clockIn: fmtDT(r[inIdx]),
      clockOut: fmtDT(r[outIdx]),
      hours: round3(hours),
      payType: "Reg",
    });
  }
  return out;
}

export function parseZenople(
  wb: XLSX.WorkBook,
  kfiSet: Set<string>,
  unmappedIds: UnmappedIdAccumulator,
): ParsedPunch[] {
  const rows = sheetRows(wb);
  const hdr = rows[0];
  if (!hdr) return [];
  const custIdx = findHeader(hdr, (s) => s === "customer");
  const pidIdx = findHeader(hdr, (s) => s.includes("person id"));
  const dtIdx = findHeader(hdr, (s) => s.includes("work date"));
  const inIdx = findHeader(hdr, (s) => s.includes("clock in"));
  const outIdx = findHeader(hdr, (s) => s.includes("clock out"));
  const brkIdx = findHeader(hdr, (s) => s.includes("break hours"));
  if (pidIdx < 0) return [];
  const out: ParsedPunch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const kfiId = r[pidIdx] != null ? String(r[pidIdx]).trim() : "";
    if (!kfiSet.has(kfiId)) {
      if (kfiId) unmappedIds.add(kfiId);
      continue;
    }
    if (r[inIdx] == null || r[outIdx] == null) continue;
    const date = r[dtIdx] != null ? fmtDate(r[dtIdx]) : "";
    const brk = parseFloat(String(r[brkIdx] ?? "0")) || 0;
    let hours = 0;
    try {
      const ci = parseTime12(date, String(r[inIdx]));
      const co = parseTime12(date, String(r[outIdx]));
      if (co < ci) co.setDate(co.getDate() + 1);
      hours = round3((co.getTime() - ci.getTime()) / 3_600_000 - brk);
    } catch {
      // ignore
    }
    out.push({
      kfiId,
      customer: String(r[custIdx] ?? "Unknown"),
      date,
      clockIn: `${date} ${r[inIdx]}`,
      clockOut: `${date} ${r[outIdx]}`,
      hours,
      payType: "Reg",
    });
  }
  return out;
}

export function parseBurnett(
  wb: XLSX.WorkBook,
  kfiSet: Set<string>,
  unmappedIds: UnmappedIdAccumulator,
  idMap: IdMap = EMBEDDED_MAPPING,
): ParsedPunch[] {
  const rows = sheetRows(wb);
  const hdr = rows[0];
  if (!hdr) return [];
  const empIdx = findHeader(hdr, (s) => s.includes("employee id"));
  const dateIdx = findHeader(hdr, (s) => s === "work date");
  const inIdx = findHeader(
    hdr,
    (s) => s.includes("punch in time") && !s.includes("round"),
  );
  const outIdx = findHeader(
    hdr,
    (s) => s.includes("punch out time") && !s.includes("round"),
  );
  const regIdx = findHeader(hdr, (s) => s.includes("regular duration"));
  const ot1Idx = findHeader(hdr, (s) => s.includes("ot1 duration"));
  if (empIdx < 0) return [];
  const out: ParsedPunch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[empIdx] == null) continue;
    const empId = String(Math.round(Number(r[empIdx])));
    const mapped = idMap[empId] ?? (kfiSet.has(empId) ? empId : "");
    const kfiId = mapped && kfiSet.has(mapped) ? mapped : "";
    if (!kfiId) {
      if (/^\d+$/.test(empId)) unmappedIds.add(empId);
      continue;
    }
    if (r[inIdx] == null || r[outIdx] == null) continue;
    const reg = parseFloat(String(r[regIdx] ?? "0")) || 0;
    const ot1 = parseFloat(String(r[ot1Idx] ?? "0")) || 0;
    const hours = round3(reg + ot1);
    if (hours === 0) continue;
    out.push({
      kfiId,
      customer: "Burnett Dairy - Grantsburg",
      date: fmtDate(r[dateIdx]),
      clockIn: fmtDT(r[inIdx]),
      clockOut: fmtDT(r[outIdx]),
      hours,
      payType: ot1 > 0 ? "OT" : "Reg",
    });
  }
  return out;
}
