import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Usage log: who opened which tile, when. Separate from user_audit_log, which
// records admin ACTIONS — this records navigation.
//
// No PII beyond the user reference. actorUserId is nullable so deleting a user
// keeps the history.
export const tileEventTable = pgTable(
  "tile_event",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    email: text("email"),
    tile: text("tile").notNull(),
    // open | login
    kind: text("kind").notNull().default("open"),
    detail: text("detail"),
    // client | server
    source: text("source").notNull().default("client"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tile_event_opened").on(t.openedAt),
    index("idx_tile_event_user_opened").on(t.userId, t.openedAt),
  ],
);

export type TileEvent = typeof tileEventTable.$inferSelect;
