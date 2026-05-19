import * as XLSX from "xlsx";
import {
  parseAdientXLSX,
  parseBurnett,
  parseGreystone,
  parseLSI,
  parsePendaTrienda,
  parseZenople,
} from "./xlsx.js";
import { parseAdientPDF, parseDelalloPDF, parseIWGPDF } from "./pdf.js";
import { UnmappedIdAccumulator } from "./types.js";
import type { ParseResult } from "./types.js";

/**
 * Registry mapping the `parser_name` stored in `customer_column_schemas`
 * to the actual parser function. The cache lookup in /extract-customer-file
 * (per-row uploads) resolves a parser name from the DB and calls back
 * through here so the route never imports the parser modules directly.
 *
 * Names are hand-written, not derived from function names, so a rename
 * inside `xlsx.ts` doesn't silently break the cache rows seeded at boot.
 */
export type LegacyParserName =
  | "adient-xlsx"
  | "adient-pdf"
  | "iwg-pdf"
  | "delallo-pdf"
  | "trienda-xlsx"
  | "penda-xlsx"
  | "greystone-xlsx"
  | "lsi-xlsx"
  | "burnett-xlsx"
  | "zenople-xlsx";

export const LEGACY_PARSER_SEEDS: ReadonlyArray<{
  customer: string;
  parserName: LegacyParserName;
  format: "xlsx" | "pdf";
}> = [
  { customer: "Adient", parserName: "adient-xlsx", format: "xlsx" },
  { customer: "Adient", parserName: "adient-pdf", format: "pdf" },
  {
    customer: "International Wire Group",
    parserName: "iwg-pdf",
    format: "pdf",
  },
  { customer: "DeLallo", parserName: "delallo-pdf", format: "pdf" },
  { customer: "Trienda", parserName: "trienda-xlsx", format: "xlsx" },
  { customer: "Penda", parserName: "penda-xlsx", format: "xlsx" },
  { customer: "Greystone", parserName: "greystone-xlsx", format: "xlsx" },
  {
    customer: "Landscape Structures",
    parserName: "lsi-xlsx",
    format: "xlsx",
  },
  {
    customer: "Burnett Dairy - Grantsburg",
    parserName: "burnett-xlsx",
    format: "xlsx",
  },
  { customer: "Zenople", parserName: "zenople-xlsx", format: "xlsx" },
];

/**
 * Run a registered legacy parser by name. Centralizing dispatch here
 * keeps the route free of per-customer if/else and matches the
 * data-driven nature of the cache lookup.
 *
 * Returns null when the parser name is unknown (treated by callers as
 * "fall through to AI" — the seed rows should never produce this).
 */
export async function dispatchLegacyParser(
  parserName: string,
  fileName: string,
  buffer: Buffer,
  kfiSet: Set<string>,
  weekStart: string,
  idMap?: Record<string, string>,
): Promise<ParseResult | null> {
  const year = parseInt(weekStart.slice(0, 4));
  const unmappedIds = new UnmappedIdAccumulator();
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");

  // Format guard: parsers are silently wrong (return 0 rows) if fed the
  // wrong file kind. We do this here so a stale cache row never causes
  // confusing 0-punch errors.
  switch (parserName) {
    case "adient-xlsx":
    case "trienda-xlsx":
    case "penda-xlsx":
    case "greystone-xlsx":
    case "lsi-xlsx":
    case "burnett-xlsx":
    case "zenople-xlsx":
      if (!isXlsx) return null;
      break;
    case "adient-pdf":
    case "iwg-pdf":
    case "delallo-pdf":
      if (!isPdf) return null;
      break;
  }

  let wb: XLSX.WorkBook | null = null;
  if (isXlsx) wb = XLSX.read(buffer, { type: "buffer", cellDates: true });

  let customer: string;
  let punches;
  switch (parserName) {
    case "adient-xlsx":
      customer = "Adient";
      punches = parseAdientXLSX(wb!, kfiSet, unmappedIds, idMap);
      break;
    case "adient-pdf":
      customer = "Adient";
      punches = await parseAdientPDF(buffer, kfiSet, year, unmappedIds, idMap);
      break;
    case "iwg-pdf":
      customer = "International Wire Group";
      punches = await parseIWGPDF(buffer, kfiSet, unmappedIds, idMap);
      break;
    case "delallo-pdf":
      customer = "DeLallo";
      punches = await parseDelalloPDF(buffer, kfiSet, year, unmappedIds, idMap);
      break;
    case "trienda-xlsx":
      customer = "Trienda";
      punches = parsePendaTrienda(wb!, "Trienda", kfiSet, unmappedIds, idMap);
      break;
    case "penda-xlsx":
      customer = "Penda";
      punches = parsePendaTrienda(wb!, "Penda", kfiSet, unmappedIds, idMap);
      break;
    case "greystone-xlsx":
      customer = "Greystone";
      punches = parseGreystone(wb!, kfiSet, unmappedIds);
      break;
    case "lsi-xlsx":
      customer = "Landscape Structures";
      punches = parseLSI(wb!, kfiSet, unmappedIds, idMap);
      break;
    case "burnett-xlsx":
      customer = "Burnett Dairy - Grantsburg";
      punches = parseBurnett(wb!, kfiSet, unmappedIds, idMap);
      break;
    case "zenople-xlsx":
      customer = "Zenople";
      punches = parseZenople(wb!, kfiSet, unmappedIds);
      break;
    default:
      return null;
  }
  return { customer, punches, unmappedIds: unmappedIds.toArray() };
}
