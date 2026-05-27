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
  log?: { info: (obj: object, msg: string) => void },
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
  // Task #441: emit one `schema_lookup` line per upload so we can tell
  // from logs whether the cache hit, missed (signature changed or no
  // row yet), and which (customer, format) pair was looked up.
  // signature_prefix is the first 8 chars only — enough to correlate
  // with the schema_cache_write line for the same upload, without
  // dumping the full sha256.
  const kind: "cache" | "miss" = hit && hit.columnRoles ? "cache" : "miss";
  log?.info(
    {
      customer,
      format,
      signature_prefix: signature.slice(0, 8),
      kind,
    },
    "schema_lookup",
  );
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
  // Task #402: routed through safeBulkDelete so every boot writes an
  // audit row (including the steady-state "matched=0" no-op). The
  // legacy-parser sentinel set is bounded (≤ the number of customers,
  // historically <20), but in production we still cap it via the guard
  // threshold — if a real future regression ever produces hundreds of
  // sentinel rows, that's much more likely a bug than something the
  // boot should silently delete.
  const { safeBulkDelete } = await import("../safeBulkDelete.js");
  const result = await safeBulkDelete({
    routine: "deleteLegacyParserSchemaRows",
    tableLabel: "customer_column_schemas (source=legacy-parser)",
    table: schema.customerColumnSchemasTable,
    where: eq(schema.customerColumnSchemasTable.source, "legacy-parser"),
    threshold: 50,
  });
  return { deleted: result.deleted };
}
