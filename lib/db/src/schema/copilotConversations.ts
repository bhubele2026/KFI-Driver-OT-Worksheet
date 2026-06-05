import {
  pgTable,
  serial,
  text,
  date,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Task #451: the global "Worksheet Copilot" — an agentic, app-wide Claude
 * assistant that can read AND mutate the worksheet in plain language. Unlike
 * the per-customer upload chat (`customer_upload_chats`), a copilot
 * conversation is scoped to a single signed-in user and can act across any
 * week / driver / customer. These tables are intentionally separate from the
 * upload-chat tables so the two features evolve independently.
 */
export const copilotConversationsTable = pgTable(
  "copilot_conversations",
  {
    id: serial("id").primaryKey(),
    /** Owner of the conversation. Conversations are private to their owner. */
    userId: integer("user_id").notNull(),
    /** Short human label (first user message, truncated). */
    title: text("title"),
    /**
     * The context the conversation was opened in, used as the copilot's
     * default scope when the user doesn't name a week/driver explicitly.
     * Refreshed on each turn from the page the dispatcher is on.
     */
    contextWeekStart: date("context_week_start"),
    contextKfiId: text("context_kfi_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("copilot_conversations_user_idx").on(t.userId, t.updatedAt),
    foreignKey({
      name: "copilot_conversations_user_fk",
      columns: [t.userId],
      foreignColumns: [usersTable.id],
    }).onDelete("cascade"),
  ],
);

export type CopilotConversation =
  typeof copilotConversationsTable.$inferSelect;

/**
 * A single step the copilot took within one assistant turn: which tool it
 * called, the input it passed, and a compact result summary. Surfaced in the
 * UI as a collapsible "what the copilot did" trail so the dispatcher can see
 * the read-before-write reasoning and every mutation that ran.
 */
export type CopilotToolStep = {
  /** Tool name, e.g. "get_week_summary" or "add_manual_punch". */
  tool: string;
  /** The arguments Claude passed (already JSON-safe). */
  input: Record<string, unknown>;
  /** Whether the underlying operation succeeded. */
  ok: boolean;
  /** Whether this tool mutated data (drives UI cache invalidation). */
  mutating: boolean;
  /** One-line human summary of the outcome. */
  summary: string;
  /** HTTP status of the loopback call, when applicable. */
  status?: number;
};

/**
 * An action the copilot wants to take that is gated behind an explicit
 * confirmation (destructive or bulk: deletes, week reset, large multi-row
 * adds, anything over the bulk threshold). The assistant turn returns this
 * with `actionStatus = "pending"`; the dispatcher confirms or cancels, and
 * only on confirm does the backend replay the underlying loopback call(s).
 */
export type CopilotPendingAction = {
  /** Stable kind discriminator, e.g. "delete_punch", "bulk_add_punches". */
  kind: string;
  /** Human title shown on the confirmation card. */
  title: string;
  /** Bullet-point summary of exactly what will change. */
  summary: string[];
  /**
   * The concrete loopback calls to execute on confirm, in order. Each is a
   * method + path + optional JSON body against the app's own `/api` surface.
   * Replaying these reuses every existing guard / audit / attribution path.
   */
  calls: Array<{
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    /** One-line description for the per-call result trail. */
    label: string;
  }>;
};

export type CopilotActionResult = {
  ok: boolean;
  results: Array<{ label: string; status: number; ok: boolean; detail?: string }>;
};

export const copilotMessagesTable = pgTable(
  "copilot_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id").notNull(),
    /** "user" | "assistant". */
    role: text("role").notNull(),
    /** Prose content. For the user this is their message; for the assistant, Claude's reply. */
    content: text("content").notNull().default(""),
    /** Ordered trail of tool calls the assistant made on this turn. */
    toolSteps: jsonb("tool_steps").$type<CopilotToolStep[] | null>(),
    /** A confirmation-gated action awaiting the dispatcher's decision. */
    pendingAction: jsonb("pending_action").$type<CopilotPendingAction | null>(),
    /** null | "pending" | "executed" | "cancelled" | "failed". */
    actionStatus: text("action_status"),
    /** The outcome once a pending action is confirmed and replayed. */
    actionResult: jsonb("action_result").$type<CopilotActionResult | null>(),
    /** Model used for the turn (assistant rows only). */
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    /** Author of the message (the dispatcher who typed it). Null for assistant. */
    authorUserId: integer("author_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("copilot_messages_conversation_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    foreignKey({
      name: "copilot_messages_conversation_fk",
      columns: [t.conversationId],
      foreignColumns: [copilotConversationsTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "copilot_messages_author_fk",
      columns: [t.authorUserId],
      foreignColumns: [usersTable.id],
    }).onDelete("set null"),
  ],
);

export type CopilotMessage = typeof copilotMessagesTable.$inferSelect;
