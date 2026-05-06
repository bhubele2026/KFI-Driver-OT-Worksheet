import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

// Schema compatible with `connect-pg-simple` default table layout.
export const sessionsTable = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6, withTimezone: false }).notNull(),
  },
  (t) => [index("IDX_session_expire").on(t.expire)],
);
