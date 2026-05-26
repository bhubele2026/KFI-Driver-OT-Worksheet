import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { customerUploadChatMessagesTable } from "./customerUploadChats";

/**
 * Task #406: per-customer "lessons" Claude has learned from past
 * dispatcher corrections. Prepended to the AI extractor's system prompt
 * on every future extraction for the same customer so the model stops
 * making the same mistake twice. Customer-scoped (by display name) — no
 * cross-customer leakage.
 *
 * NOTE: FK constraint names are declared explicitly so they stay under
 * Postgres' 63-char identifier limit; the auto-generated names
 * (`customer_extraction_lessons_created_from_chat_message_id_customer_upload_chat_messages_id_fk`)
 * would be truncated by pg, then read back differently by drizzle-kit
 * push, producing perpetual drift.
 */
export const customerExtractionLessonsTable = pgTable(
  "customer_extraction_lessons",
  {
    id: serial("id").primaryKey(),
    customer: text("customer").notNull(),
    lessonText: text("lesson_text").notNull(),
    createdFromChatMessageId: integer("created_from_chat_message_id"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    updatedBy: integer("updated_by"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    index("customer_extraction_lessons_customer_idx").on(t.customer, t.active),
    foreignKey({
      name: "cel_chat_message_fk",
      columns: [t.createdFromChatMessageId],
      foreignColumns: [customerUploadChatMessagesTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "cel_created_by_fk",
      columns: [t.createdBy],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "cel_updated_by_fk",
      columns: [t.updatedBy],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
  ],
);

export type CustomerExtractionLesson =
  typeof customerExtractionLessonsTable.$inferSelect;
