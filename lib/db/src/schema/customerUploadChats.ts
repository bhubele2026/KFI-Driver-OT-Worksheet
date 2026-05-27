import {
  pgTable,
  serial,
  text,
  date,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Task #406: one chat session per (week, customer). The dispatcher uses
 * the chat to ask Claude to fix an "almost right" customer upload —
 * e.g. add a missing day, alias an unrecognised driver name, or
 * re-extract the file with a hint. Each session is scoped to a single
 * customer-week so Claude never sees other customers' data.
 */
export const customerUploadChatsTable = pgTable(
  "customer_upload_chats",
  {
    id: serial("id").primaryKey(),
    weekStart: date("week_start").notNull(),
    customer: text("customer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("customer_upload_chats_week_customer_idx").on(
      t.weekStart,
      t.customer,
    ),
    foreignKey({
      name: "cuc_created_by_fk",
      columns: [t.createdBy],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
  ],
);

export type CustomerUploadChat =
  typeof customerUploadChatsTable.$inferSelect;

/**
 * A single proposed fix Claude can return from a chat turn. The
 * dispatcher reviews it on a "proposed change" card and clicks
 * Apply or Dismiss. The `kind` discriminates the payload shape;
 * apply-side route reuses existing manual-punch / PATCH-punch /
 * alias / extract code paths.
 */
export type ProposedFix =
  | {
      kind: "addPunches";
      punches: Array<{
        kfiId: string;
        date: string;
        clockIn: string;
        clockOut: string;
        payType?: "Reg" | "OT" | null;
        notes?: string;
      }>;
    }
  | {
      kind: "editPunch";
      punchId: number;
      clockIn?: string;
      clockOut?: string;
      date?: string;
      hours?: number;
    }
  | {
      kind: "deletePunch";
      punchId: number;
      reason: string;
    }
  | {
      kind: "addDriverAlias";
      nameOnDoc: string;
      kfiId: string;
    }
  | {
      kind: "reExtractWithHint";
      hint: string;
      sampleId?: number;
    };

/**
 * Task #420: rows the assistant pulled from the uploaded customer
 * file (via `read_upload_file_rows`) on the turn that produced the
 * proposed fix. Surfaced to the dispatcher as a collapsible
 * "Evidence from file" block so they can sanity-check the proposal
 * without re-opening the spreadsheet. Stored on the assistant
 * message row at turn-write time.
 *
 * Rows are de-duplicated across multiple tool calls within the same
 * turn — a runaway loop calling the same filter five times only
 * persists the rows once.
 *
 * Task #424: when the assistant falls back to `read_upload_file_raw`
 * (xlsx → CSV, text-bearing PDF, OCR transcription), the returned
 * slice is also captured here as a `rawSnippets` entry (file name,
 * total/returned chars, first ~500 chars) so the dispatcher can see
 * exactly what raw text the assistant grounded its proposal on.
 * De-duplicated across multiple raw-reads within the same turn by
 * (sampleId, snippet) so repeated reads of the same prefix collapse
 * to a single entry.
 */
export type FileEvidence = {
  sampleId: number;
  fileName: string;
  resolvedRows: Array<{
    kfiId: string;
    driverName: string | null;
    date: string;
    clockIn: string;
    clockOut: string;
    hours: number | null;
    payType: string | null;
  }>;
  pendingRows: Array<{
    driverNameOnDoc: string;
    badgeOrId: string | null;
    date: string;
    timeIn: string | null;
    timeOut: string | null;
    hours: number | null;
  }>;
  rawSnippets?: Array<{
    sampleId: number;
    fileName: string;
    totalChars: number;
    returnedChars: number;
    truncated: boolean;
    snippet: string;
  }>;
};

export const customerUploadChatMessagesTable = pgTable(
  "customer_upload_chat_messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id").notNull(),
    /** "user" | "assistant" | "system" */
    role: text("role").notNull(),
    /** Plain text content. For tool-driven turns this is Claude's prose. */
    content: text("content").notNull(),
    /** Optional structured fix payload Claude proposed in this turn. */
    proposedFix: jsonb("proposed_fix").$type<ProposedFix | null>(),
    /** Optional one-line lesson Claude wants to remember. */
    proposedLesson: text("proposed_lesson"),
    /**
     * Task #420: rows pulled from the uploaded customer file via the
     * `read_upload_file_rows` tool during this turn. Surfaced to the
     * dispatcher as a collapsible "Evidence from file" block beside
     * the proposed fix so they can sanity-check it.
     */
    fileEvidence: jsonb("file_evidence").$type<FileEvidence | null>(),
    /** When the dispatcher applied the proposed fix (if ever). */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedBy: integer("applied_by"),
    /** When the dispatcher dismissed the proposed fix (if ever). */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedBy: integer("dismissed_by"),
    /** Author of the message (the dispatcher who typed it). Null for assistant. */
    authorUserId: integer("author_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("customer_upload_chat_messages_chat_idx").on(t.chatId, t.createdAt),
    foreignKey({
      name: "cucm_chat_fk",
      columns: [t.chatId],
      foreignColumns: [customerUploadChatsTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "cucm_applied_by_fk",
      columns: [t.appliedBy],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "cucm_dismissed_by_fk",
      columns: [t.dismissedBy],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
    foreignKey({
      name: "cucm_author_fk",
      columns: [t.authorUserId],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
  ],
);

export type CustomerUploadChatMessage =
  typeof customerUploadChatMessagesTable.$inferSelect;
