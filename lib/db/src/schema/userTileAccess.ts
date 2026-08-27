import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Which tiles a person may see. One row per (user, tile).
//
// Deliberately independent of users.is_admin: an admin may reach Settings and
// the admin API, but which tiles they SEE is a separate axis the owner
// controls. The owner (ADMIN_EMAILS) holds every tile implicitly and has no
// rows here.
export const userTileAccessTable = pgTable(
  "user_tile_access",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tile: text("tile").notNull(),
    grantedByUserId: integer("granted_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_user_tile_unique").on(t.userId, t.tile),
    index("idx_user_tile_user").on(t.userId),
  ],
);

export type UserTileAccess = typeof userTileAccessTable.$inferSelect;
