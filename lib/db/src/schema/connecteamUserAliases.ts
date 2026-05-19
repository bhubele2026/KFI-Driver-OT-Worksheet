import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { driversTable } from "./drivers";

// Admin-managed alias map: Connecteam userId -> KFI driver id. Promotes the
// legacy hardcoded USER_ID_ALIASES_LD into an editable table so a dispatcher
// can stitch together a driver who appears on multiple clocks under different
// Connecteam userIds without a code change.
//
// Loaded on every Connecteam refresh and merged with the static seed at
// resolution time; DB rows win so an admin can override a stale entry.
export const connecteamUserAliasesTable = pgTable(
  "connecteam_user_aliases",
  {
    ctUserId: integer("ct_user_id").primaryKey(),
    kfiId: text("kfi_id")
      .notNull()
      .references(() => driversTable.kfiId, { onDelete: "cascade" }),
    note: text("note"),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    updatedBy: integer("updated_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("connecteam_user_aliases_ct_user_id_idx").on(t.ctUserId),
  ],
);

export type ConnecteamUserAlias =
  typeof connecteamUserAliasesTable.$inferSelect;
