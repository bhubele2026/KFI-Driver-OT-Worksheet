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
 * pipeline. Lookup key is `(lower(customer), header_signature, format)`.
 *
 * Task #277 ripped out the hand-written deterministic parsers; the
 * only live row shape now is:
 *
 *  **AI-discovered roles** (`source = 'ai'`, `column_roles` set,
 *  `header_signature` = the file's actual header hash). Written by the
 *  upload route after a successful AI extraction so subsequent uploads
 *  with the same header layout skip AI and use the generic role-based
 *  reader (`readWithRoles` / `readPdfWithRoles`).
 *
 * Historical: rows with `source = 'legacy-parser'` and
 * `header_signature = '*'` were seeded at boot for every
 * `KNOWN_CUSTOMERS` entry. The boot path now deletes those instead;
 * see `deleteLegacyParserSchemaRows` in `lib/parsers/schemaLookup.ts`.
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
     * Stable SHA-256 of the file's normalized header row. The legacy
     * `'*'` sentinel value (used by the boot-seeded legacy-parser rows
     * before Task #277) is no longer written; the boot cleanup removes
     * any leftover `'*'` rows it finds.
     */
    headerSignature: text("header_signature").notNull().default("*"),
    /**
     * Source of this schema row:
     *  - `'ai'`: AI-discovered column roles stored in `columnRoles`.
     *  - `'seed'`: hand-curated column roles (future use).
     *  - `'legacy-parser'`: historical only — boot cleanup removes
     *    these on startup (Task #277).
     */
    source: text("source").notNull(),
    /**
     * Historical: identifier of the hand-written parser to delegate to
     * when `source = 'legacy-parser'`. Now always null on new writes
     * — Task #277 removed the legacy parsers.
     */
    parserName: text("parser_name"),
    /**
     * File extension this schema applies to (`'xlsx'` / `'pdf'`). Used
     * during lookup so a PDF dropped on a customer with an xlsx-only
     * learned schema falls through to AI instead of trying the wrong
     * column roles.
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
    // Uniqueness on (customer, headerSignature, format) so multiple
    // AI-discovered layouts for the same customer can coexist as long
    // as their header signatures or formats differ.
    uniqueIndex("customer_column_schemas_customer_sig_format_uq").on(
      t.customer,
      t.headerSignature,
      t.format,
    ),
  ],
);

export type CustomerColumnSchemaRow =
  typeof customerColumnSchemasTable.$inferSelect;
