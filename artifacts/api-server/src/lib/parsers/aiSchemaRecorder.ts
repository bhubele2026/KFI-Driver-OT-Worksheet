import * as XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import * as schema from "@workspace/db/schema";
import { computeHeaderSignature } from "./schemaSignature.js";
import type { ParseResult } from "./types.js";

/**
 * Locate the xlsx column indices that carried the badge / date /
 * timeIn / timeOut / hours values of the AI's first emitted punch.
 *
 * Approach: parse the workbook, for each row see whether it contains
 * the punch's normalized badge AND date string. The matching row's
 * cells reveal which columns hold each field. Returns null if no
 * confident match — caller skips persisting (better to re-run AI next
 * time than cache wrong roles).
 */
export function inferColumnRoles(
  buffer: Buffer,
  sample: {
    rawBadge: string;
    dateIso: string;
    clockIn: string;
    clockOut: string;
  },
): {
  badge: number;
  date: number;
  timeIn: number;
  timeOut: number;
  hours?: number | null;
} | null {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    return null;
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
  });
  const badgeNeedle = sample.rawBadge.trim().toLowerCase();
  const dateNeedle = sample.dateIso;
  const timeInNeedle = sample.clockIn.split(" ").slice(1).join(" "); // "H:MM AM"
  const timeOutNeedle = sample.clockOut.split(" ").slice(1).join(" ");

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    let badgeCol = -1;
    let dateCol = -1;
    let timeInCol = -1;
    let timeOutCol = -1;
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (v == null) continue;
      const s =
        v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
      if (
        badgeCol < 0 &&
        s.toLowerCase() === badgeNeedle
      ) {
        badgeCol = i;
        continue;
      }
      if (dateCol < 0) {
        if (v instanceof Date) {
          if (v.toISOString().slice(0, 10) === dateNeedle) {
            dateCol = i;
            continue;
          }
        } else if (s.includes(dateNeedle.slice(5))) {
          // tolerate M/D variants
          dateCol = i;
          continue;
        }
      }
      if (
        timeInCol < 0 &&
        timeInNeedle &&
        s.toUpperCase().includes(timeInNeedle.toUpperCase())
      ) {
        timeInCol = i;
        continue;
      }
      if (
        timeOutCol < 0 &&
        timeOutNeedle &&
        timeOutNeedle !== timeInNeedle &&
        s.toUpperCase().includes(timeOutNeedle.toUpperCase())
      ) {
        timeOutCol = i;
        continue;
      }
    }
    if (
      badgeCol >= 0 &&
      dateCol >= 0 &&
      timeInCol >= 0 &&
      timeOutCol >= 0
    ) {
      return {
        badge: badgeCol,
        date: dateCol,
        timeIn: timeInCol,
        timeOut: timeOutCol,
      };
    }
  }
  return null;
}

/**
 * After a successful AI extraction on an xlsx upload, derive column
 * roles by locating the first AI punch's values in the workbook and
 * upsert a `customer_column_schemas` row keyed on (customer, signature,
 * format='xlsx'). On subsequent uploads with the same header layout
 * the route's lookupSchema -> 'cache' branch consumes these roles via
 * `readWithRoles`, skipping AI entirely.
 *
 * No-op for non-xlsx files (images/PDFs), when no signature can be
 * computed, when AI returned 0 punches, or when roles can't be
 * confidently inferred. Designed to never throw — failure here only
 * costs the next upload another AI call.
 */
export async function recordAiSchemaIfPossible(args: {
  customer: string;
  fileName: string;
  buffer: Buffer;
  aiResult: ParseResult;
  log: { warn: (obj: object, msg: string) => void };
}): Promise<boolean> {
  const { customer, fileName, buffer, aiResult, log } = args;
  try {
    const signature = computeHeaderSignature(fileName, buffer);
    if (!signature) return false;
    const first = aiResult.punches[0];
    if (!first) return false;
    // Reverse-look up the rawBadge: aiResult.punches[].kfiId is the
    // mapped value, but the xlsx contains the raw badge. We need the
    // raw value; AI returned it via `badgeOrId` upstream. Skip if we
    // can't reconstruct it — caller decides to call us only when raw
    // badge is recoverable from idMap inversion.
    // Simpler: scan the workbook for the kfiId itself. If unmapped,
    // try the kfiId.
    const sample = {
      rawBadge: first.kfiId,
      dateIso: first.date,
      clockIn: first.clockIn,
      clockOut: first.clockOut,
    };
    const roles = inferColumnRoles(buffer, sample);
    if (!roles) return false;
    await db
      .insert(schema.customerColumnSchemasTable)
      .values({
        customer,
        headerSignature: signature,
        source: "ai",
        parserName: null,
        format: "xlsx",
        columnRoles: roles,
      })
      .onConflictDoUpdate({
        target: [
          schema.customerColumnSchemasTable.customer,
          schema.customerColumnSchemasTable.headerSignature,
          schema.customerColumnSchemasTable.format,
        ],
        set: {
          columnRoles: roles,
          source: "ai",
        },
      });
    return true;
  } catch (err) {
    log.warn({ err, customer, fileName }, "recordAiSchemaIfPossible failed");
    return false;
  }
}

/** Test seam: clear all AI-source rows for a customer. */
export async function __clearAiSchemasForCustomer(
  customer: string,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__clearAiSchemasForCustomer is a test seam");
  }
  await db.execute(
    sql`DELETE FROM customer_column_schemas WHERE lower(customer)=lower(${customer}) AND source='ai'`,
  );
}
