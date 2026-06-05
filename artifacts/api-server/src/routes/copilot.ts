import { Router, type IRouter, type Request } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { makeLoopbackCall } from "../lib/copilot/loopback.js";
import {
  runCopilotTurn,
  executePendingAction,
} from "../lib/copilot/runCopilotTurn.js";
import type {
  CopilotConversation,
  CopilotMessage,
} from "@workspace/db/schema";

/**
 * Task #451 (T006/T008): HTTP surface for the global Worksheet Copilot.
 *
 * Conversations are private to the signed-in user. Each turn runs the
 * agentic loop in `lib/copilot/runCopilotTurn.ts`, which calls the app's
 * own `/api` endpoints through an authenticated loopback bound to THIS
 * request's session cookie — so the copilot can only ever do what the
 * dispatcher could do themselves. Destructive / bulk actions are not
 * executed inline: the turn returns a `pendingAction` persisted on the
 * assistant message; the dispatcher confirms (replay) or cancels.
 */

export const copilotRouter: IRouter = Router();

copilotRouter.use("/copilot", requireAuth);

const MAX_MESSAGE_CHARS = 8_000;

function ctxFromBody(body: unknown): {
  weekStart: string | null;
  kfiId: string | null;
} {
  const b = (body ?? {}) as { context?: { weekStart?: unknown; kfiId?: unknown } };
  const c = b.context ?? {};
  const weekStart =
    typeof c.weekStart === "string" && c.weekStart.trim()
      ? c.weekStart.trim()
      : null;
  const kfiId =
    typeof c.kfiId === "string" && c.kfiId.trim() ? c.kfiId.trim() : null;
  return { weekStart, kfiId };
}

function serializeConversation(c: CopilotConversation): Record<string, unknown> {
  return {
    id: c.id,
    title: c.title,
    weekStart: c.contextWeekStart,
    kfiId: c.contextKfiId,
    createdAt: new Date(c.createdAt).toISOString(),
    updatedAt: new Date(c.updatedAt).toISOString(),
  };
}

function serializeMessage(m: CopilotMessage): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    toolSteps: m.toolSteps ?? null,
    pendingAction: m.pendingAction ?? null,
    actionStatus: m.actionStatus ?? null,
    actionResult: m.actionResult ?? null,
    model: m.model ?? null,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    costUsd: m.costUsd,
    createdAt: new Date(m.createdAt).toISOString(),
  };
}

async function loadOwnedConversation(
  id: number,
  userId: number,
): Promise<CopilotConversation | null> {
  const rows = await db
    .select()
    .from(schema.copilotConversationsTable)
    .where(
      and(
        eq(schema.copilotConversationsTable.id, id),
        eq(schema.copilotConversationsTable.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Run one turn against a conversation and persist user + assistant rows. */
async function runTurnForConversation(
  conversation: CopilotConversation,
  message: string,
  context: { weekStart: string | null; kfiId: string | null },
  req: Request,
): Promise<CopilotMessage> {
  const reqUser = (req as { user?: { id: number; isAdmin: boolean } }).user;
  const userId = reqUser?.id ?? req.session.userId!;
  const isAdmin = Boolean(reqUser?.isAdmin);

  // Persist the user turn first so history stays consistent even if the
  // Claude call throws.
  await db.insert(schema.copilotMessagesTable).values({
    conversationId: conversation.id,
    role: "user",
    content: message,
    authorUserId: userId,
  });

  const priorRows = await db
    .select({
      role: schema.copilotMessagesTable.role,
      content: schema.copilotMessagesTable.content,
    })
    .from(schema.copilotMessagesTable)
    .where(eq(schema.copilotMessagesTable.conversationId, conversation.id))
    .orderBy(asc(schema.copilotMessagesTable.createdAt));
  const prior = priorRows
    .slice(0, -1)
    .filter(
      (h): h is { role: "user" | "assistant"; content: string } =>
        h.role === "user" || h.role === "assistant",
    );

  // Refresh the conversation's default scope from the page the dispatcher
  // is on so later turns inherit it.
  await db
    .update(schema.copilotConversationsTable)
    .set({ contextWeekStart: context.weekStart, contextKfiId: context.kfiId })
    .where(eq(schema.copilotConversationsTable.id, conversation.id));

  let turn;
  try {
    turn = await runCopilotTurn({
      history: prior,
      userMessage: message,
      context,
      user: { id: userId, isAdmin },
      call: makeLoopbackCall(req.headers.cookie),
    });
  } catch (err) {
    req.log.error({ err, conversationId: conversation.id }, "copilot turn failed");
    const msg = err instanceof Error ? err.message : "copilot turn failed";
    const [failRow] = await db
      .insert(schema.copilotMessagesTable)
      .values({
        conversationId: conversation.id,
        role: "assistant",
        content: `Sorry — I couldn't complete that: ${msg}`,
      })
      .returning();
    throw Object.assign(new Error(msg), { assistantRow: failRow });
  }

  const [assistantRow] = await db
    .insert(schema.copilotMessagesTable)
    .values({
      conversationId: conversation.id,
      role: "assistant",
      content: turn.assistantText,
      toolSteps: turn.toolSteps.length > 0 ? turn.toolSteps : null,
      pendingAction: turn.pendingAction,
      actionStatus: turn.pendingAction ? "pending" : null,
      model: turn.model,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costUsd: turn.costUsd,
    })
    .returning();

  req.log.info(
    {
      conversationId: conversation.id,
      toolSteps: turn.toolSteps.length,
      mutations: turn.toolSteps.filter((s) => s.mutating).length,
      pending: turn.pendingAction?.kind ?? null,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costUsd: turn.costUsd,
    },
    "copilot turn complete",
  );
  return assistantRow;
}

// ── list conversations ───────────────────────────────────────────────
copilotRouter.get("/copilot/conversations", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db
    .select()
    .from(schema.copilotConversationsTable)
    .where(eq(schema.copilotConversationsTable.userId, userId))
    .orderBy(desc(schema.copilotConversationsTable.updatedAt))
    .limit(50);
  res.json({ conversations: rows.map(serializeConversation) });
});

// ── start a new conversation (with the first message) ────────────────
copilotRouter.post("/copilot/conversations", async (req, res) => {
  const userId = req.session.userId!;
  const message = String(
    (req.body as { message?: unknown })?.message ?? "",
  ).trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) {
    res
      .status(400)
      .json({ error: `message is required (1–${MAX_MESSAGE_CHARS} chars)` });
    return;
  }
  const context = ctxFromBody(req.body);
  const title = message.length > 80 ? `${message.slice(0, 80)}…` : message;
  const [conversation] = await db
    .insert(schema.copilotConversationsTable)
    .values({
      userId,
      title,
      contextWeekStart: context.weekStart,
      contextKfiId: context.kfiId,
    })
    .returning();

  try {
    const assistantRow = await runTurnForConversation(
      conversation,
      message,
      context,
      req,
    );
    res.json({
      conversation: serializeConversation(conversation),
      message: serializeMessage(assistantRow),
    });
  } catch (err) {
    const row = (err as { assistantRow?: CopilotMessage }).assistantRow;
    const msg = err instanceof Error ? err.message : "copilot turn failed";
    if (row) {
      res
        .status(/budget/i.test(msg) ? 402 : 400)
        .json({
          conversation: serializeConversation(conversation),
          message: serializeMessage(row),
        });
      return;
    }
    throw err;
  }
});

// ── get one conversation with its messages ───────────────────────────
copilotRouter.get("/copilot/conversations/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  const conversation = await loadOwnedConversation(id, userId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const messages = await db
    .select()
    .from(schema.copilotMessagesTable)
    .where(eq(schema.copilotMessagesTable.conversationId, id))
    .orderBy(asc(schema.copilotMessagesTable.createdAt));
  res.json({
    conversation: serializeConversation(conversation),
    messages: messages.map(serializeMessage),
  });
});

// ── continue a conversation ──────────────────────────────────────────
copilotRouter.post("/copilot/conversations/:id/messages", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  const message = String(
    (req.body as { message?: unknown })?.message ?? "",
  ).trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) {
    res
      .status(400)
      .json({ error: `message is required (1–${MAX_MESSAGE_CHARS} chars)` });
    return;
  }
  const conversation = await loadOwnedConversation(id, userId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const context = ctxFromBody(req.body);
  try {
    const assistantRow = await runTurnForConversation(
      conversation,
      message,
      context,
      req,
    );
    res.json({ message: serializeMessage(assistantRow) });
  } catch (err) {
    const row = (err as { assistantRow?: CopilotMessage }).assistantRow;
    const msg = err instanceof Error ? err.message : "copilot turn failed";
    if (row) {
      res
        .status(/budget/i.test(msg) ? 402 : 400)
        .json({ message: serializeMessage(row) });
      return;
    }
    throw err;
  }
});

// ── confirm (execute) a pending action ───────────────────────────────
copilotRouter.post(
  "/copilot/conversations/:id/messages/:messageId/confirm",
  async (req, res) => {
    const userId = req.session.userId!;
    const id = parseInt(req.params.id, 10);
    const messageId = parseInt(req.params.messageId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(messageId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const conversation = await loadOwnedConversation(id, userId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const rows = await db
      .select()
      .from(schema.copilotMessagesTable)
      .where(eq(schema.copilotMessagesTable.id, messageId))
      .limit(1);
    const msg = rows[0];
    if (!msg || msg.conversationId !== id) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (!msg.pendingAction || msg.actionStatus !== "pending") {
      res.status(409).json({ error: "No pending action to confirm" });
      return;
    }
    const result = await executePendingAction(
      makeLoopbackCall(req.headers.cookie),
      msg.pendingAction,
    );
    const [updated] = await db
      .update(schema.copilotMessagesTable)
      .set({
        actionStatus: result.ok ? "executed" : "failed",
        actionResult: result,
      })
      .where(eq(schema.copilotMessagesTable.id, messageId))
      .returning();
    req.log.info(
      {
        conversationId: id,
        messageId,
        kind: msg.pendingAction.kind,
        ok: result.ok,
      },
      "copilot pending action confirmed",
    );
    res.json({ message: serializeMessage(updated) });
  },
);

// ── cancel a pending action ──────────────────────────────────────────
copilotRouter.post(
  "/copilot/conversations/:id/messages/:messageId/cancel",
  async (req, res) => {
    const userId = req.session.userId!;
    const id = parseInt(req.params.id, 10);
    const messageId = parseInt(req.params.messageId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(messageId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const conversation = await loadOwnedConversation(id, userId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const rows = await db
      .select()
      .from(schema.copilotMessagesTable)
      .where(eq(schema.copilotMessagesTable.id, messageId))
      .limit(1);
    const msg = rows[0];
    if (!msg || msg.conversationId !== id) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (!msg.pendingAction || msg.actionStatus !== "pending") {
      res.status(409).json({ error: "No pending action to cancel" });
      return;
    }
    const [updated] = await db
      .update(schema.copilotMessagesTable)
      .set({ actionStatus: "cancelled" })
      .where(eq(schema.copilotMessagesTable.id, messageId))
      .returning();
    res.json({ message: serializeMessage(updated) });
  },
);

export default copilotRouter;
