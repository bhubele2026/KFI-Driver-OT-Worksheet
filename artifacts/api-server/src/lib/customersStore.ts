import { asc } from "drizzle-orm";
import { db, schema } from "./db.js";

export type CustomerExt = "xlsx" | "pdf";

export interface CustomerRow {
  id: number;
  displayName: string;
  filenameKeywords: string[];
  extensions: CustomerExt[];
  active: boolean;
  sortOrder: number;
}

function normalizeExtensions(value: readonly string[]): CustomerExt[] {
  const out: CustomerExt[] = [];
  for (const v of value) {
    if (v === "xlsx" || v === "pdf") out.push(v);
  }
  return out;
}

/**
 * Load every customer row in stable display order. Replaces the static
 * `KNOWN_CUSTOMERS` array — filename routing, the dropdown, the
 * customer-files panel and the timesheets sidebar all read from here.
 */
export async function loadCustomers(): Promise<CustomerRow[]> {
  const rows = await db
    .select()
    .from(schema.customersTable)
    .orderBy(asc(schema.customersTable.sortOrder), asc(schema.customersTable.id));
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    filenameKeywords: r.filenameKeywords ?? [],
    extensions: normalizeExtensions(r.extensions ?? []),
    active: r.active,
    sortOrder: r.sortOrder,
  }));
}

/** Active customers only — the per-week panel / dropdowns. */
export async function loadActiveCustomers(): Promise<CustomerRow[]> {
  const all = await loadCustomers();
  return all.filter((c) => c.active);
}

/**
 * Lightweight name detection used for status-tracking error attribution.
 * Returns the displayName of the first customer whose keyword appears in
 * the filename. Does NOT consider extension — that's the parser router's
 * job. Returns null when no customer matches.
 */
export function detectCustomerFromFileName(
  fileName: string,
  customers: readonly CustomerRow[],
): string | null {
  const lower = fileName.toLowerCase();
  for (const c of customers) {
    if (c.filenameKeywords.some((k) => k && lower.includes(k.toLowerCase()))) {
      return c.displayName;
    }
  }
  return null;
}
