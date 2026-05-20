import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Admin-managed per-Connecteam-clock hour offsets. Applied during ingest in
// `lib/connecteam.ts` so dispatchers can fix clocks whose raw timestamps drift
// from what the driver actually punched (the legacy Shuster +1h fix) without
// a code change. Loaded once per refresh.
export const clockOffsetsTable = pgTable("clock_offsets", {
  clockId: text("clock_id").primaryKey(),
  hoursOffset: numeric("hours_offset", { precision: 6, scale: 2 })
    .notNull()
    .default("0"),
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
});

export type ClockOffset = typeof clockOffsetsTable.$inferSelect;
