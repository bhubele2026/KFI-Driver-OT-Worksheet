import {
  pgTable,
  serial,
  text,
  date,
  integer,
  timestamp,
  customType,
  boolean,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export interface StashedExtractedPunch {
  kfiId: string;
  customer: string;
  date: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  payType: "Reg" | "OT";
  noTz?: boolean;
}

/**
 * AI rows the extractor could NOT resolve to a kfiId before stash time.
 * /confirm-customer-file re-resolves these against the just-written
 * customer_name_aliases / driver_id_aliases (driven by the dispatcher's
 * picker) and appends any newly-resolved punches to the import.
 */
export interface PendingNamedRow {
  driverNameOnDoc: string;
  badgeOrId: string | null;
  date: string;
  timeIn: string | null;
  timeOut: string | null;
  hours: number | null;
}

// Stashed copy of every AI-extracted customer file so an engineer can use it
// as a fixture when promoting the customer to a deterministic parser.
//
// Lifecycle:
//   - inserted (confirmed_at NULL) when /extract-new-customer succeeds
//   - flipped to confirmed_at = now() when the dispatcher confirms via
//     /confirm-new-customer
//   - rows where confirmed_at is NULL are purged after 24h (the dispatcher
//     bailed on the import); confirmed rows are purged after 90 days
//   - rows with pinned=true are exempt from the TTL purge entirely (admin
//     opt-in safety net for fixtures we don't want to lose)
export const aiExtractSamplesTable = pgTable(
  "ai_extract_samples",
  {
    id: serial("id").primaryKey(),
    weekStart: date("week_start").notNull(),
    customer: text("customer").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    fileBytes: bytea("file_bytes").notNull(),
    uploadedBy: integer("uploaded_by"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    pinned: boolean("pinned").notNull().default(false),
    extractedRows: jsonb("extracted_rows").$type<StashedExtractedPunch[]>(),
    pendingNamedRows: jsonb("pending_named_rows").$type<PendingNamedRow[]>(),
  },
  (t) => [
    index("ai_extract_samples_customer_idx").on(t.customer),
    index("ai_extract_samples_expires_at_idx").on(t.expiresAt),
  ],
);

export type AiExtractSample = typeof aiExtractSamplesTable.$inferSelect;
