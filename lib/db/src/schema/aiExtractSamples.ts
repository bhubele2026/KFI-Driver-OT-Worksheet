import {
  pgTable,
  serial,
  text,
  date,
  integer,
  timestamp,
  customType,
  index,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// Stashed copy of every AI-extracted customer file so an engineer can use it
// as a fixture when promoting the customer to a deterministic parser.
//
// Lifecycle:
//   - inserted (confirmed_at NULL) when /extract-new-customer succeeds
//   - flipped to confirmed_at = now() when the dispatcher confirms via
//     /confirm-new-customer
//   - rows where confirmed_at is NULL are purged after 24h (the dispatcher
//     bailed on the import); confirmed rows are purged after 90 days
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
  },
  (t) => [
    index("ai_extract_samples_customer_idx").on(t.customer),
    index("ai_extract_samples_expires_at_idx").on(t.expiresAt),
  ],
);

export type AiExtractSample = typeof aiExtractSamplesTable.$inferSelect;
