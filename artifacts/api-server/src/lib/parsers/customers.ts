// Single source of truth for the known weekly customers and how their files
// are routed to a parser. Order matters: the first entry whose extension
// allows it AND whose keyword appears in the filename wins. Keep more
// specific keywords first.

export type CustomerExt = "xlsx" | "pdf";

export interface KnownCustomer {
  /** Canonical display name as it appears in the punches table. */
  displayName: string;
  /** Lowercase substrings that match the uploaded filename. */
  keywords: string[];
  /** File extensions this customer's parser accepts. */
  extensions: CustomerExt[];
}

/**
 * Lightweight name detection used for status-tracking error attribution. Does
 * NOT consider extension; the parser router does that. Returns the displayName
 * of the first matching known customer, or null.
 */
export function detectCustomerFromFileName(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  for (const c of KNOWN_CUSTOMERS) {
    if (c.keywords.some((k) => lower.includes(k))) return c.displayName;
  }
  return null;
}

export const KNOWN_CUSTOMERS: readonly KnownCustomer[] = [
  { displayName: "Adient", keywords: ["adient"], extensions: ["xlsx", "pdf"] },
  {
    displayName: "International Wire Group",
    keywords: ["iwg", "wire"],
    extensions: ["pdf"],
  },
  {
    displayName: "DeLallo",
    keywords: ["delallo", "dellalo"],
    extensions: ["pdf"],
  },
  { displayName: "Trienda", keywords: ["trienda"], extensions: ["xlsx"] },
  { displayName: "Penda", keywords: ["penda"], extensions: ["xlsx"] },
  { displayName: "Greystone", keywords: ["greystone"], extensions: ["xlsx"] },
  {
    displayName: "Landscape Structures",
    keywords: ["lsi", "landscape"],
    extensions: ["xlsx"],
  },
  {
    displayName: "Burnett Dairy - Grantsburg",
    keywords: ["burnett"],
    extensions: ["xlsx"],
  },
  {
    displayName: "Zenople",
    keywords: ["time_clock", "time clock", "zenople"],
    extensions: ["xlsx"],
  },
];
