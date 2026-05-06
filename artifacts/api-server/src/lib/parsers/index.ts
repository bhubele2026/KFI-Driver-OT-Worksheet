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
import type { ParseResult } from "./types.js";

export type * from "./types.js";

export async function detectAndParseFile(
  fileName: string,
  buffer: Buffer,
  kfiSet: Set<string>,
  weekStart: string,
): Promise<ParseResult | null> {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const year = parseInt(weekStart.slice(0, 4));

  if (isPdf) {
    // Adient kept the PDF parser around for legacy files but switched to XLSX
    // in 2026; new XLSX path is below.
    if (lower.includes("adient")) {
      return { customer: "Adient", punches: await parseAdientPDF(buffer, kfiSet, year) };
    }
    if (lower.includes("iwg") || lower.includes("wire")) {
      return {
        customer: "International Wire Group",
        punches: await parseIWGPDF(buffer, kfiSet),
      };
    }
    if (lower.includes("delallo") || lower.includes("dellalo")) {
      return {
        customer: "DeLallo",
        punches: await parseDelalloPDF(buffer, kfiSet, year),
      };
    }
    return null;
  }

  // xlsx / xls
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });

  if (lower.includes("adient")) {
    return { customer: "Adient", punches: parseAdientXLSX(wb, kfiSet) };
  }
  if (lower.includes("trienda")) {
    return { customer: "Trienda", punches: parsePendaTrienda(wb, "Trienda", kfiSet) };
  }
  if (lower.includes("penda")) {
    return { customer: "Penda", punches: parsePendaTrienda(wb, "Penda", kfiSet) };
  }
  if (lower.includes("greystone")) {
    return { customer: "Greystone", punches: parseGreystone(wb, kfiSet) };
  }
  if (lower.includes("lsi") || lower.includes("landscape")) {
    return { customer: "Landscape Structures", punches: parseLSI(wb, kfiSet) };
  }
  if (lower.includes("burnett")) {
    return { customer: "Burnett Dairy - Grantsburg", punches: parseBurnett(wb, kfiSet) };
  }
  if (lower.includes("time_clock") || lower.includes("time clock") || lower.includes("zenople")) {
    return { customer: "Zenople", punches: parseZenople(wb, kfiSet) };
  }
  return null;
}
