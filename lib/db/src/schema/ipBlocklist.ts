import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Network-edge blocklist for repeat-offender IPs. Auth middleware consults a
// short-lived in-memory snapshot of this table and rejects matching requests
// with 403 *before* they reach the rate limiter, so a sustained brute-force
// attempt stops costing us bcrypt cycles or DB round-trips.
export const ipBlocklistTable = pgTable("ip_blocklist", {
  ip: text("ip").primaryKey(),
  reason: text("reason"),
  createdByUserId: integer("created_by_user_id").references(
    () => usersTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type IpBlocklistEntry = typeof ipBlocklistTable.$inferSelect;
