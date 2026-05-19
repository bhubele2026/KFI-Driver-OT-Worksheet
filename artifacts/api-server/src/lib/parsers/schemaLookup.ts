import { sql, and, eq } from "drizzle-orm";
import { db } from "../db.js";
import * as schema from "@workspace/db/schema";
import { computeHeaderSignature } from "./schemaSignature.js";

/**
 * Result of looking up a schema row for an upload. Two outcomes:
 *  - `cache`: an AI-discovered column-roles row matching the file's
 *    header signature. Use the generic role-based reader to skip AI.
 *  - `miss`: nothing matches. Caller falls through to AI extraction.
 *
 * Task #277 removed the legacy-parser sentinel branch: every customer
 * now goes through the same AI-first pipeline (cache lookup → AI →
 * cache write).
 */
export type SchemaLookupResult =
  | {
      kind: "cache";
      columnRoles: Record<string, unknown>;
      headerSignature: string;
      format: "xlsx" | "pdf";
    }
  | { kind: "miss" };

/**
 * Resolve which extraction strategy to use for a per-row upload.
 *
 * Lookup order:
 *  1. Compute the file's header signature (xlsx and PDF; images skip).
 *  2. Match an existing `(customer, signature, format)` AI-discovered
 *     cache row → fast generic reader.
 *  3. Otherwise `miss` → caller runs AI extraction (which then writes
 *     the cache row for the next upload of the same layout).
 */
export async function lookupSchema(
  customer: string,
  fileName: string,
  buffer: Buffer,
  isImage: boolean,
): Promise<SchemaLookupResult> {
  const lower = fileName.toLowerCase();
  const format: "xlsx" | "pdf" | null = isImage
    ? null
    : lower.endsWith(".pdf")
      ? "pdf"
      : lower.endsWith(".xlsx") || lower.endsWith(".xls")
        ? "xlsx"
        : null;
  if (!format) return { kind: "miss" };

  const signature = await computeHeaderSignature(fileName, buffer);
  if (!signature) return { kind: "miss" };

  const rows = await db
    .select()
    .from(schema.customerColumnSchemasTable)
    .where(
      and(
        sql`lower(${schema.customerColumnSchemasTable.customer}) = lower(${customer})`,
        eq(schema.customerColumnSchemasTable.format, format),
        eq(schema.customerColumnSchemasTable.headerSignature, signature),
      ),
    );

  const hit = rows.find((r) => r.columnRoles);
  if (hit && hit.columnRoles) {
    return {
      kind: "cache",
      columnRoles: hit.columnRoles as Record<string, unknown>,
      headerSignature: hit.headerSignature,
      format,
    };
  }
  return { kind: "miss" };
}

/**
 * One-time idempotent cleanup of legacy-parser sentinel rows. Task #277
 * removed the legacy-parser branch entirely, so any rows left over from
 * the old boot seed are inert — but cleaner to drop them. Safe to run
 * on every boot; no-op once the rows are gone.
 */
export async function deleteLegacyParserSchemaRows(): Promise<{
  deleted: number;
}> {
  const result = await db
    .delete(schema.customerColumnSchemasTable)
    .where(eq(schema.customerColumnSchemasTable.source, "legacy-parser"))
    .returning({ id: schema.customerColumnSchemasTable.id });
  return { deleted: result.length };
}
