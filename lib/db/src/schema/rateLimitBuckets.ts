import {
  pgTable,
  text,
  integer,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

// Persistent rate-limit buckets shared across API instances.
// One row per (limiter name, key) pair. `count` is the number of attempts
// recorded in the current window; `reset_at` is when the window expires and
// the bucket should be considered empty.
export const rateLimitBucketsTable = pgTable(
  "rate_limit_buckets",
  {
    name: text("name").notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull().default(0),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.name, t.key] }),
    index("rate_limit_buckets_reset_at_idx").on(t.resetAt),
  ],
);

export type RateLimitBucket = typeof rateLimitBucketsTable.$inferSelect;
