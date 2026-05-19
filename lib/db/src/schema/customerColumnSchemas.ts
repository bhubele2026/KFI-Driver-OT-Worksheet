import {
  pgTable,
  serial,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-customer parser registry that backs the uniform per-row upload
 * pipeline. Lookup key is `(lower(customer), header_signature)`.
 *
 * Two row shapes coexist:
 *
 *  1. **Legacy-parser sentinel** (`source = 'legacy-parser'`,
 *     `parser_name` set, `column_roles` null, `header_signature = '*'`).
 *     Seeded at boot for every entry in `KNOWN_CUSTOMERS` so the
 *     per-row uploader can short-circuit to a fast deterministic parser
 *     when the customer has a hand-written one. The `*` signature is a
 *     customer-level fallback the lookup uses when nothing matches the
 *     actual file's computed signature.
 *
 *  2. **AI-discovered roles** (`source = 'ai'`, `column_roles` set,
 *     `header_signature` = the file's actual header hash). Written by
 *     the route after a successful AI extraction so subsequent uploads
 *     with the same header layout skip AI and use the generic
 *     role-based reader. (Generic reader not yet wired — table is in
 *     place to support it; see drift on Task #250.)
 *
 * Either way the route does ONE lookup at upload time, in the same
 * order, regardless of customer or file format. That's the
 * "every per-row upload starts the same way" property the user asked
 * for after the Trienda 90s timeout incident.
 */
export const customerColumnSchemasTable = pgTable(
  "customer_column_schemas",
  {
    id: serial("id").primaryKey(),
    /** Canonical customer display name (matches punches.customer). */
    customer: text("customer").notNull(),
    /**
     * Stable SHA-256 of the file's normalized header row, or `'*'` for
     * customer-level legacy-parser sentinels seeded at boot. The route
     * looks up by exact signature first, then falls back to `'*'`.
     */
    headerSignature: text("header_signature").notNull().default("*"),
    /**
     * Source of this schema row:
     *  - `'legacy-parser'`: seeded; delegates to `parserName`.
     *  - `'ai'`: AI-discovered column roles stored in `columnRoles`.
     *  - `'seed'`: hand-curated column roles (future use).
     */
    source: text("source").notNull(),
    /**
     * Identifier of the hand-written parser to delegate to when
     * `source = 'legacy-parser'`. Matches `dispatchLegacyParser` in
     * `lib/parsers/index.ts`. Null for AI rows.
     */
    parserName: text("parser_name"),
    /**
     * File extension this schema applies to (`'xlsx'` / `'pdf'`). Used
     * during lookup so a PDF dropped on a customer with only an xlsx
     * parser falls through to AI instead of trying the wrong parser.
     */
    format: text("format").notNull(),
    /**
     * Column-role map for the generic reader, when `source = 'ai'` or
     * `'seed'`. Shape: `{ "0": "badge", "3": "date", "5": "timeIn", ... }`.
     */
    columnRoles: jsonb("column_roles"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Uniqueness on (customer, headerSignature, format) so:
    //  - a customer like Adient with both an xlsx and a pdf legacy
    //    parser can coexist with the same `'*'` sentinel signature
    //  - boot-time seeds and later AI-discovered rows can coexist as
    //    long as their signatures differ.
    uniqueIndex("customer_column_schemas_customer_sig_format_uq").on(
      t.customer,
      t.headerSignature,
      t.format,
    ),
  ],
);

export type CustomerColumnSchemaRow =
  typeof customerColumnSchemasTable.$inferSelect;
