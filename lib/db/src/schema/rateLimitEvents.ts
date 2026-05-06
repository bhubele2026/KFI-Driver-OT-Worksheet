import {
  pgTable,
  serial,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Append-only history of rate-limit threshold hits. The live
// `rate_limit_buckets` row vanishes once its window expires, taking the
// "this IP got blocked" signal with it. We write one row here every time a
// bucket transitions from "below threshold" to "blocked" so admins can chart
// repeat offenders and make blocklist decisions.
export const rateLimitEventsTable = pgTable(
  "rate_limit_events",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    key: text("key").notNull(),
    blockedAt: timestamp("blocked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiredAt: timestamp("expired_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("rate_limit_events_blocked_at_idx").on(t.blockedAt),
    index("rate_limit_events_name_key_idx").on(t.name, t.key),
  ],
);

export type RateLimitEvent = typeof rateLimitEventsTable.$inferSelect;
