import * as XLSX from "xlsx";
import {
  parseAdientXLSX,
  parseBurnett,
  parseGreystone,
  parseLSI,
  parsePendaTrienda,
  parseZenople,
} from "./xlsx.js";
import {
  parseAdientPDF,
  parseDelalloPDF,
  parseIWGPDF,
} from "./pdf.js";
import { KNOWN_CUSTOMERS } from "./customers.js";
import type { ParseResult, ParsedPunch } from "./types.js";

export type * from "./types.js";
export { KNOWN_CUSTOMERS } from "./customers.js";

function detectCustomer(
  fileName: string,
  isPdf: boolean,
): string | null {
  const lower = fileName.toLowerCase();
  for (const c of KNOWN_CUSTOMERS) {
    if (isPdf && !c.extensions.includes("pdf")) continue;
    if (!isPdf && !c.extensions.includes("xlsx")) continue;
    if (c.keywords.some((k) => lower.includes(k))) return c.displayName;
  }
  return null;
}

export async function detectAndParseFile(
  fileName: string,
  buffer: Buffer,
  kfiSet: Set<string>,
  weekStart: string,
): Promise<ParseResult | null> {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const year = parseInt(weekStart.slice(0, 4));
  const customer = detectCustomer(fileName, isPdf);
  if (!customer) return null;

  let punches: ParsedPunch[] = [];
  const unmappedIds = new Set<string>();
  if (isPdf) {
    if (customer === "Adient") {
      // Legacy digital PDF path; current Adient export is XLSX.
      punches = await parseAdientPDF(buffer, kfiSet, year, unmappedIds);
    } else if (customer === "International Wire Group") {
      punches = await parseIWGPDF(buffer, kfiSet, unmappedIds);
    } else if (customer === "DeLallo") {
      punches = await parseDelalloPDF(buffer, kfiSet, year, unmappedIds);
    }
  } else {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    if (customer === "Adient") punches = parseAdientXLSX(wb, kfiSet, unmappedIds);
    else if (customer === "Trienda")
      punches = parsePendaTrienda(wb, "Trienda", kfiSet, unmappedIds);
    else if (customer === "Penda")
      punches = parsePendaTrienda(wb, "Penda", kfiSet, unmappedIds);
    else if (customer === "Greystone")
      punches = parseGreystone(wb, kfiSet, unmappedIds);
    else if (customer === "Landscape Structures")
      punches = parseLSI(wb, kfiSet, unmappedIds);
    else if (customer === "Burnett Dairy - Grantsburg")
      punches = parseBurnett(wb, kfiSet, unmappedIds);
    else if (customer === "Zenople")
      punches = parseZenople(wb, kfiSet, unmappedIds);
  }
  return { customer, punches, unmappedIds: [...unmappedIds].sort() };
}
