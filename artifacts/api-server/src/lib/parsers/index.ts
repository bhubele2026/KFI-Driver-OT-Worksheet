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
import { UnmappedIdAccumulator } from "./types.js";
import type { ParseResult, ParsedPunch } from "./types.js";

export type * from "./types.js";
export { UnmappedIdAccumulator } from "./types.js";
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

/**
 * Run the deterministic parser for an explicitly-chosen customer if (and
 * only if) the file extension matches that customer's parser list.
 * Returns null when the deterministic parser is not applicable (wrong
 * extension, unknown customer, or image) — callers should fall back to AI.
 */
export function canDeterministicallyParse(
  fileName: string,
  customer: string,
): boolean {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");
  if (!isPdf && !isXlsx) return false;
  const c = KNOWN_CUSTOMERS.find(
    (k) => k.displayName.toLowerCase() === customer.toLowerCase(),
  );
  if (!c) return false;
  if (isPdf && !c.extensions.includes("pdf")) return false;
  if (isXlsx && !c.extensions.includes("xlsx")) return false;
  return true;
}

export async function detectAndParseFile(
  fileName: string,
  buffer: Buffer,
  kfiSet: Set<string>,
  weekStart: string,
  idMap?: Record<string, string>,
  // When the dispatcher explicitly aimed at a customer (per-row upload
  // / drag-drop), force that customer rather than guessing from the
  // filename. Bypasses the keyword scan so a file like "kronos-week.xlsx"
  // dropped on the Penda row parses as Penda, not as whatever the
  // keywords happen to match.
  explicitCustomer?: string,
): Promise<ParseResult | null> {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const year = parseInt(weekStart.slice(0, 4));
  const customer = explicitCustomer
    ? KNOWN_CUSTOMERS.find(
        (k) => k.displayName.toLowerCase() === explicitCustomer.toLowerCase(),
      )?.displayName ?? null
    : detectCustomer(fileName, isPdf);
  if (!customer) return null;

  let punches: ParsedPunch[] = [];
  const unmappedIds = new UnmappedIdAccumulator();
  if (isPdf) {
    if (customer === "Adient") {
      // Legacy digital PDF path; current Adient export is XLSX.
      punches = await parseAdientPDF(buffer, kfiSet, year, unmappedIds, idMap);
    } else if (customer === "International Wire Group") {
      punches = await parseIWGPDF(buffer, kfiSet, unmappedIds, idMap);
    } else if (customer === "DeLallo") {
      punches = await parseDelalloPDF(buffer, kfiSet, year, unmappedIds, idMap);
    }
  } else {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    if (customer === "Adient") punches = parseAdientXLSX(wb, kfiSet, unmappedIds, idMap);
    else if (customer === "Trienda")
      punches = parsePendaTrienda(wb, "Trienda", kfiSet, unmappedIds, idMap);
    else if (customer === "Penda")
      punches = parsePendaTrienda(wb, "Penda", kfiSet, unmappedIds, idMap);
    else if (customer === "Greystone")
      punches = parseGreystone(wb, kfiSet, unmappedIds);
    else if (customer === "Landscape Structures")
      punches = parseLSI(wb, kfiSet, unmappedIds, idMap);
    else if (customer === "Burnett Dairy - Grantsburg")
      punches = parseBurnett(wb, kfiSet, unmappedIds, idMap);
    else if (customer === "Zenople")
      punches = parseZenople(wb, kfiSet, unmappedIds);
  }
  return { customer, punches, unmappedIds: unmappedIds.toArray() };
}
