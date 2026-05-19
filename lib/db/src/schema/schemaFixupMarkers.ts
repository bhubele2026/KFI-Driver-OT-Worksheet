import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const schemaFixupMarkersTable = pgTable("schema_fixup_markers", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
