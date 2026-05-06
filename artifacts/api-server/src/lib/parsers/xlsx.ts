import * as XLSX from "xlsx";
import { fmtDate, fmtDT } from "../time.js";
import { EMBEDDED_MAPPING } from "../mappings.js";
import type { ParsedPunch } from "./types.js";

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
    const kfiId =
      EMBEDDED_MAPPING[empId] ?? (kfiSet.has(empId) ? empId : "");
    if (!kfiId) continue;
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
): ParsedPunch[] {
  const rows = sheetRows(wb);
  const hdr = rows[0];
  if (!hdr) return [];
  const fnIdx = findHeader(hdr, (s) => s.includes("file number"));
  const dtIdx = findHeader(hdr, (s) => s.includes("pay date"));
  const inIdx = findHeader(hdr, (s) => s === "time in");
  const outIdx = findHeader(hdr, (s) => s === "time out");
  const hrIdx = findHeader(hdr, (s) => s === "hours");
  if (fnIdx < 0) return [];
  const out: ParsedPunch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[fnIdx] == null) continue;
    const kfiId = String(Math.round(Number(r[fnIdx])));
    if (!kfiSet.has(kfiId)) continue;
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

export function parseLSI(
  wb: XLSX.WorkBook,
  _kfiSet: Set<string>,
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
    const kfiId =
      EMBEDDED_MAPPING[posId] ?? EMBEDDED_MAPPING[posId + "N"] ?? "";
    if (!kfiId) continue;
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
    if (!kfiSet.has(kfiId)) continue;
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
    const kfiId =
      EMBEDDED_MAPPING[empId] ?? (kfiSet.has(empId) ? empId : "");
    if (!kfiId) continue;
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
