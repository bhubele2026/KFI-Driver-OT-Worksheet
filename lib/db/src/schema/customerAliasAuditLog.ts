import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Append-only audit of changes to customer_name_aliases. Captures who
// re-mapped or forgot a (customer, name-on-doc) → driver mapping and
// records the before/after kfiId so a regression can be traced back to
// the admin (or dispatcher, in the case of forgets) who changed it.
export const customerAliasAuditLogTable = pgTable(
  "customer_alias_audit_log",
  {
    id: serial("id").primaryKey(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    customer: text("customer").notNull(),
    nameOnDoc: text("name_on_doc").notNull(),
    // 'remap' | 'forget'
    action: text("action").notNull(),
    beforeKfiId: text("before_kfi_id"),
    afterKfiId: text("after_kfi_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_customer_alias_audit_created").on(t.createdAt),
    index("idx_customer_alias_audit_customer").on(t.customer, t.nameOnDoc),
  ],
);

export type CustomerAliasAuditLog =
  typeof customerAliasAuditLogTable.$inferSelect;
