import { sql } from "drizzle-orm";
import { db } from "../db.js";
import * as schema from "@workspace/db/schema";

/**
 * Phase-2 durable per-customer import EXCEPTION rules.
 *
 * These live in `customers.import_rules` (a nullable JSONB column) rather
 * than in the header-signature cache (`customer_column_schemas`) so they
 * survive AI re-learning and weekly file drift — the header hash changes
 * every time a customer tweaks a column, but the rule for "read the
 * timesheet sheet, not the Zenople export" is stable.
 *
 * The rules steer the AI extraction prompt (via {@link rulesToDirectives},
 * which turns each rule into a plain-English lesson line prepended to the
 * prompt for BOTH the known-customer weekly path and re-extraction) and
 * drive a deterministic post-extract total-row drop
 * ({@link applyRulesToRows}) that works in every lane.
 *
 * Nothing here is required: a customer with no rule row keeps the
 * default behavior, which as of the Phase-2 core already honors each
 * file's own Hours/Total column.
 */
export interface CustomerImportRules {
  /**
   * Reinforce that the file's Total/Hours/Duration column is authoritative
   * (break + rounding already netted). The Phase-2 core made this the
   * global default, so this flag is mainly a per-customer *override* knob:
   * set it false for a customer whose provided total is unreliable and you
   * want hours recomputed from clock in/out.
   */
  trustProvidedHours?: boolean;
  /**
   * How the driver's name is laid out in the file. `splitLastFirst` =
   * separate Last / First (or Preferred) columns (Burnett, Shusters, LSI);
   * `combined` = one "Full Name" / "Employee Name" cell. Steers the AI so
   * it stops conflating same-surname drivers (the Carlos-vs-Luis bug).
   */
  nameMode?: "combined" | "splitLastFirst";
  /**
   * For multi-sheet workbooks, the sheet to read (name or 1-based index as
   * a string). Orgill ships a "Master External" Zenople export as sheet 1
   * and the real timecard as another sheet — this pins the timecard.
   */
  sheetSelector?: string;
  /**
   * When a file shows both scheduled and actual times, which to use.
   * WB Manufacturing ships scheduled-vs-actual; payroll wants `actual`.
   */
  timeColumnMode?: "actual" | "scheduled";
  /**
   * Fallback unpaid-break minutes to subtract ONLY when a customer gives
   * clock times with no computed total (rare now that we honor totals).
   */
  breakMinutes?: number;
  /**
   * Case-insensitive substrings that mark a row as a grand-total /
   * subtotal / pay-code line to drop (e.g. "grand total", "subtotal",
   * "total hours", "regular", "overtime", "holiday"). Matched against the
   * driver-name-on-doc and badge text. The >20h implausible-shift guard
   * already catches most totals; this catches small totals that slip
   * under 20h (LSI per-day pay-code rows).
   */
  dropTotalRowPatterns?: string[];
  /** Free-text note shown in the admin UI; never sent to the model. */
  notes?: string;
}

const KNOWN_KEYS = new Set<keyof CustomerImportRules>([
  "trustProvidedHours",
  "nameMode",
  "sheetSelector",
  "timeColumnMode",
  "breakMinutes",
  "dropTotalRowPatterns",
  "notes",
]);

/** Narrow an arbitrary JSONB value into a clean CustomerImportRules. */
export function normalizeRules(raw: unknown): CustomerImportRules | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: CustomerImportRules = {};
  if (typeof src.trustProvidedHours === "boolean")
    out.trustProvidedHours = src.trustProvidedHours;
  if (src.nameMode === "combined" || src.nameMode === "splitLastFirst")
    out.nameMode = src.nameMode;
  if (typeof src.sheetSelector === "string" && src.sheetSelector.trim())
    out.sheetSelector = src.sheetSelector.trim();
  if (src.timeColumnMode === "actual" || src.timeColumnMode === "scheduled")
    out.timeColumnMode = src.timeColumnMode;
  if (typeof src.breakMinutes === "number" && Number.isFinite(src.breakMinutes))
    out.breakMinutes = Math.max(0, Math.round(src.breakMinutes));
  if (Array.isArray(src.dropTotalRowPatterns)) {
    const pats = src.dropTotalRowPatterns
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter(Boolean);
    if (pats.length) out.dropTotalRowPatterns = pats;
  }
  if (typeof src.notes === "string" && src.notes.trim())
    out.notes = src.notes.trim();
  // Empty object → treat as "no rule" so callers can skip cheaply.
  return Object.keys(out).length ? out : null;
}

/** Drop any unknown keys before persisting so the column stays clean. */
export function sanitizeRulesForStore(raw: unknown): CustomerImportRules | null {
  const norm = normalizeRules(raw);
  if (!norm) return null;
  for (const k of Object.keys(norm) as (keyof CustomerImportRules)[]) {
    if (!KNOWN_KEYS.has(k)) delete norm[k];
  }
  return norm;
}

/**
 * Load the import rules for a customer by display name (case-insensitive).
 * Returns null on any miss so callers can treat it as "default behavior".
 */
export async function loadCustomerRules(
  customer: string,
): Promise<CustomerImportRules | null> {
  if (!customer) return null;
  try {
    const rows = await db
      .select({ importRules: schema.customersTable.importRules })
      .from(schema.customersTable)
      .where(
        sql`lower(${schema.customersTable.displayName}) = lower(${customer})`,
      )
      .limit(1);
    return normalizeRules(rows[0]?.importRules ?? null);
  } catch {
    // A missing column (pre-migration) or any read error must never break
    // an upload — fall back to default behavior.
    return null;
  }
}

/**
 * Turn a rule into plain-English directive lines prepended to the AI
 * extraction prompt (reusing the existing per-customer "lessons" block).
 * Only emits lines for fields that are set.
 */
export function rulesToDirectives(rules: CustomerImportRules | null): string[] {
  if (!rules) return [];
  const out: string[] = [];
  if (rules.sheetSelector)
    out.push(
      `This workbook has multiple sheets. Read ONLY the sheet identified by "${rules.sheetSelector}" (the real timecard). Ignore other sheets such as roster/master exports.`,
    );
  if (rules.trustProvidedHours !== false)
    out.push(
      `The file's Total / Hours / Duration column is authoritative — it already nets the unpaid break and the customer's rounding. Always report that value; never recompute hours from clock in/out.`,
    );
  else
    out.push(
      `Do NOT trust this file's stated total column; recompute hours from the actual clock in/out times.`,
    );
  if (rules.nameMode === "splitLastFirst")
    out.push(
      `Driver names are split across separate Last and First (or Preferred) columns. Combine them as "First Last" per row and keep same-surname drivers distinct — do not merge two people who share a last name.`,
    );
  else if (rules.nameMode === "combined")
    out.push(`Each row's driver name is a single combined cell.`);
  if (rules.timeColumnMode === "actual")
    out.push(
      `This file shows both scheduled and actual times. Use the ACTUAL punch times/hours, never the scheduled ones.`,
    );
  else if (rules.timeColumnMode === "scheduled")
    out.push(`Use the scheduled times for this customer.`);
  if (typeof rules.breakMinutes === "number" && rules.breakMinutes > 0)
    out.push(
      `If a row gives clock times with no computed total, subtract ${rules.breakMinutes} minutes of unpaid break before reporting hours.`,
    );
  if (rules.dropTotalRowPatterns?.length)
    out.push(
      `Ignore summary rows whose name/label contains any of: ${rules.dropTotalRowPatterns.join(", ")} — these are totals/subtotals, not punches.`,
    );
  return out;
}

/** True if a row's name/badge text looks like a drop-listed total row. */
export function isDroppableTotalRow(
  rules: CustomerImportRules | null | undefined,
  nameOnDoc: string | null | undefined,
  badge: string | null | undefined,
): boolean {
  const pats = rules?.dropTotalRowPatterns;
  if (!pats?.length) return false;
  const hay = `${nameOnDoc ?? ""} ${badge ?? ""}`.toLowerCase();
  return pats.some((p) => hay.includes(p.toLowerCase()));
}

/**
 * Deterministic post-extract filter applied in every lane: drop rows that
 * match the customer's total-row patterns. Rows are duck-typed so this
 * works on both AI-lane and cache-lane shapes (any `{ driverNameOnDoc?,
 * badgeOrId? }`-ish object).
 */
export function applyRulesToRows<
  T extends {
    driverNameOnDoc?: string | null;
    badgeOrId?: string | null;
    name?: string | null;
    badge?: string | null;
  },
>(rules: CustomerImportRules | null, rows: T[]): { kept: T[]; dropped: number } {
  if (!rules?.dropTotalRowPatterns?.length) return { kept: rows, dropped: 0 };
  const kept: T[] = [];
  let dropped = 0;
  for (const r of rows) {
    const name = r.driverNameOnDoc ?? r.name ?? null;
    const badge = r.badgeOrId ?? r.badge ?? null;
    if (isDroppableTotalRow(rules, name, badge)) {
      dropped++;
      continue;
    }
    kept.push(r);
  }
  return { kept, dropped };
}
