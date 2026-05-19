import { sql, and, eq, or } from "drizzle-orm";
import { db } from "../db.js";
import * as schema from "@workspace/db/schema";
import { computeHeaderSignature } from "./schemaSignature.js";
import { LEGACY_PARSER_SEEDS } from "./parserDispatch.js";

/**
 * Result of looking up a schema row for an upload. Three possible outcomes:
 *  - `cache`: an AI-discovered (or seeded) column-roles row matching the
 *    actual file's header signature. Use the generic role-based reader.
 *  - `legacy-parser`: a `'*'` customer-level row pointing at a hand-written
 *    parser. Delegate to `dispatchLegacyParser(parserName, ...)`.
 *  - `miss`: nothing matches. Caller falls through to AI extraction.
 */
export type SchemaLookupResult =
  | {
      kind: "cache";
      parserName: null;
      columnRoles: Record<string, string>;
      headerSignature: string;
    }
  | {
      kind: "legacy-parser";
      parserName: string;
      columnRoles: null;
      headerSignature: string;
    }
  | { kind: "miss" };

/**
 * Resolve which extraction strategy to use for a per-row upload.
 *
 * Lookup order (the "every upload starts the same" pipeline):
 *  1. If the file is an image or has no computable signature (PDF) —
 *     check only for a customer-level legacy-parser sentinel.
 *  2. Else compute the file's header signature. First, try an exact
 *     `(customer, signature)` match (cache hit — fast generic reader
 *     or future AI-roles row).
 *  3. Then fall back to the `(customer, '*')` legacy-parser sentinel
 *     (the boot-seeded "this customer has a deterministic parser" row).
 *  4. Otherwise `miss` → caller runs AI.
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

  const signature = format === "xlsx" ? computeHeaderSignature(fileName, buffer) : null;

  const sigPredicate = signature
    ? or(
        eq(schema.customerColumnSchemasTable.headerSignature, signature),
        eq(schema.customerColumnSchemasTable.headerSignature, "*"),
      )
    : eq(schema.customerColumnSchemasTable.headerSignature, "*");

  const rows = await db
    .select()
    .from(schema.customerColumnSchemasTable)
    .where(
      and(
        sql`lower(${schema.customerColumnSchemasTable.customer}) = lower(${customer})`,
        eq(schema.customerColumnSchemasTable.format, format),
        sigPredicate,
      ),
    );

  // Prefer an exact-signature match (cache/ai row) over the customer-level
  // `'*'` legacy sentinel so AI-discovered roles supersede the boot seed
  // once they're learned.
  const exact = signature
    ? rows.find((r) => r.headerSignature === signature)
    : null;
  if (exact) {
    if (exact.source === "legacy-parser" && exact.parserName) {
      return {
        kind: "legacy-parser",
        parserName: exact.parserName,
        columnRoles: null,
        headerSignature: exact.headerSignature,
      };
    }
    if (exact.columnRoles) {
      return {
        kind: "cache",
        parserName: null,
        columnRoles: exact.columnRoles as Record<string, string>,
        headerSignature: exact.headerSignature,
      };
    }
  }
  const star = rows.find((r) => r.headerSignature === "*");
  if (star?.parserName) {
    return {
      kind: "legacy-parser",
      parserName: star.parserName,
      columnRoles: null,
      headerSignature: "*",
    };
  }
  return { kind: "miss" };
}

/**
 * Idempotent boot-time seed: one `(customer, '*', legacy-parser)`
 * sentinel per entry in `LEGACY_PARSER_SEEDS`. Re-running is a no-op
 * thanks to the unique index on `(lower(customer), header_signature)`.
 *
 * Done at startup (not as a SQL migration) so the seed list lives next
 * to the parser dispatch table and stays in sync as parsers are added.
 */
export async function seedLegacyParserSchemas(): Promise<{
  inserted: number;
}> {
  let inserted = 0;
  for (const s of LEGACY_PARSER_SEEDS) {
    const result = await db
      .insert(schema.customerColumnSchemasTable)
      .values({
        customer: s.customer,
        headerSignature: "*",
        source: "legacy-parser",
        parserName: s.parserName,
        format: s.format,
        columnRoles: null,
      })
      .onConflictDoNothing({
        target: [
          schema.customerColumnSchemasTable.customer,
          schema.customerColumnSchemasTable.headerSignature,
          schema.customerColumnSchemasTable.format,
        ],
      })
      .returning({ id: schema.customerColumnSchemasTable.id });
    inserted += result.length;
  }
  return { inserted };
}
