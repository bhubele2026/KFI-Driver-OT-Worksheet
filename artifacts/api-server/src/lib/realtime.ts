import type { Response } from "express";

// In-memory pub/sub bus for live updates and presence. Single-process only —
// if/when this app is ever horizontally scaled, swap the publish/subscribe
// internals for Postgres LISTEN/NOTIFY (already documented in replit.md).
//
// Three independent maps:
//   - clients:  SSE Response objects keyed by a generated client id, plus
//               the (userId, email, weekStart) metadata so presence can be
//               derived directly from active connections.
//   - presence: heartbeat-driven viewers. Falls back to the SSE map if a
//               client hasn't POSTed /presence yet, but we keep it separate
//               so a viewer who lost their SSE (e.g. a flaky network) still
//               appears in the presence chip until their last heartbeat
//               ages out.
//   - editing:  short-lived "X is editing punch N" intents. Auto-expire so
//               a closed tab never leaves a permanent edit lock.

export type RealtimeEvent =
  | {
      type: "punch-changed";
      weekStart: string;
      kfiId: string;
      action: "create" | "update" | "delete";
      punchId?: number | null;
      actor: ActorRef | null;
    }
  | {
      type: "review-changed";
      weekStart: string;
      kfiId: string;
      status: "good" | "bad" | null;
      actor: ActorRef | null;
    }
  | {
      type: "lock-changed";
      weekStart: string;
      kfiId: string;
      locked: boolean;
      lockedByEmail: string | null;
      actor: ActorRef | null;
    }
  | {
      type: "week-refreshed";
      weekStart: string;
      actor: ActorRef | null;
    }
  | {
      type: "customer-upload";
      weekStart: string;
      customer: string;
      actor: ActorRef | null;
    }
  | {
      type: "note-changed";
      weekStart: string;
      kfiId: string;
      action: "create" | "soft-delete" | "restore";
      actor: ActorRef | null;
    }
  | {
      type: "presence";
      weekStart: string;
      viewers: PresenceViewer[];
    }
  | {
      type: "editing";
      weekStart: string;
      kfiId: string;
      punchId: number | null;
      actor: ActorRef;
      action: "start" | "stop";
      expiresAt: string;
    };

export interface ActorRef {
  userId: number;
  email: string;
}

export interface PresenceViewer {
  userId: number;
  email: string;
  kfiId: string | null;
  lastSeenAt: string;
}

interface ClientRec {
  id: string;
  res: Response;
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string | null;
  connectedAt: number;
}

interface PresenceRec {
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string | null;
  lastSeenAt: number;
}

interface EditingRec {
  weekStart: string;
  kfiId: string;
  punchId: number | null;
  userId: number;
  email: string;
  expiresAt: number;
}

const PRESENCE_TTL_MS = 15_000;
const EDITING_TTL_MS = 12_000;

const clients = new Map<string, ClientRec>();
// presence keyed by `${userId}|${weekStart}` so the same user opening the
// week + a driver page only counts once per week (we just track the latest
// kfiId they're on).
const presence = new Map<string, PresenceRec>();
// editing keyed by `${weekStart}|${kfiId}|${punchId ?? "row"}|${userId}` so
// two dispatchers editing different fields of the same row both show up.
const editing = new Map<string, EditingRec>();

function presenceKey(userId: number, weekStart: string): string {
  return `${userId}|${weekStart}`;
}

function editingKey(
  weekStart: string,
  kfiId: string,
  punchId: number | null,
  userId: number,
): string {
  return `${weekStart}|${kfiId}|${punchId ?? "row"}|${userId}`;
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function viewersForWeek(weekStart: string): PresenceViewer[] {
  pruneExpired();
  const out: PresenceViewer[] = [];
  for (const rec of presence.values()) {
    if (rec.weekStart !== weekStart) continue;
    out.push({
      userId: rec.userId,
      email: rec.email,
      kfiId: rec.kfiId,
      lastSeenAt: nowIso(rec.lastSeenAt),
    });
  }
  // stable order so the chip doesn't reshuffle on every poll
  out.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return out;
}

function pruneExpired(): void {
  const cutoffPresence = Date.now() - PRESENCE_TTL_MS;
  for (const [k, rec] of presence) {
    if (rec.lastSeenAt < cutoffPresence) presence.delete(k);
  }
  const nowMs = Date.now();
  for (const [k, rec] of editing) {
    if (rec.expiresAt <= nowMs) editing.delete(k);
  }
}

function writeSse(res: Response, event: RealtimeEvent | { type: "ping" }): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // The connection is half-closed; the client cleanup handler will run.
  }
}

function shouldDeliver(rec: ClientRec, event: RealtimeEvent): boolean {
  // Presence events are addressed by week; everything else is filtered to
  // the client's currently-subscribed week (and driver, when relevant).
  if (event.type === "presence") return rec.weekStart === event.weekStart;
  if (rec.weekStart !== (event as { weekStart: string }).weekStart) return false;
  // The driver-detail subscriber gets every event for the week so it can
  // refresh the sidebar; we'd only over-deliver tiny payloads. The week
  // summary subscriber also gets every event.
  return true;
}

export function publish(event: RealtimeEvent): void {
  for (const rec of clients.values()) {
    if (shouldDeliver(rec, event)) writeSse(rec.res, event);
  }
}

export function subscribe(args: {
  res: Response;
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string | null;
}): () => void {
  const id =
    `${args.userId}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  const rec: ClientRec = {
    id,
    res: args.res,
    userId: args.userId,
    email: args.email,
    weekStart: args.weekStart,
    kfiId: args.kfiId,
    connectedAt: Date.now(),
  };
  clients.set(id, rec);
  // Seed presence so the chip lights up immediately, without waiting for the
  // first /presence heartbeat to arrive.
  upsertPresence({
    userId: args.userId,
    email: args.email,
    weekStart: args.weekStart,
    kfiId: args.kfiId,
  });
  writeSse(args.res, { type: "presence", weekStart: args.weekStart, viewers: viewersForWeek(args.weekStart) });
  return () => {
    clients.delete(id);
    // Don't immediately drop presence — the user might just be navigating
    // between week-summary and a driver page. PRESENCE_TTL_MS handles
    // genuine disconnects.
    publish({
      type: "presence",
      weekStart: args.weekStart,
      viewers: viewersForWeek(args.weekStart),
    });
  };
}

export function upsertPresence(args: {
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string | null;
}): PresenceViewer[] {
  pruneExpired();
  presence.set(presenceKey(args.userId, args.weekStart), {
    userId: args.userId,
    email: args.email,
    weekStart: args.weekStart,
    kfiId: args.kfiId,
    lastSeenAt: Date.now(),
  });
  const viewers = viewersForWeek(args.weekStart);
  publish({ type: "presence", weekStart: args.weekStart, viewers });
  return viewers;
}

export function getPresence(weekStart: string): PresenceViewer[] {
  return viewersForWeek(weekStart);
}

export function startEditing(args: {
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string;
  punchId: number | null;
}): void {
  pruneExpired();
  const expiresAt = Date.now() + EDITING_TTL_MS;
  editing.set(
    editingKey(args.weekStart, args.kfiId, args.punchId, args.userId),
    {
      weekStart: args.weekStart,
      kfiId: args.kfiId,
      punchId: args.punchId,
      userId: args.userId,
      email: args.email,
      expiresAt,
    },
  );
  publish({
    type: "editing",
    weekStart: args.weekStart,
    kfiId: args.kfiId,
    punchId: args.punchId,
    actor: { userId: args.userId, email: args.email },
    action: "start",
    expiresAt: nowIso(expiresAt),
  });
}

export function stopEditing(args: {
  userId: number;
  email: string;
  weekStart: string;
  kfiId: string;
  punchId: number | null;
}): void {
  editing.delete(
    editingKey(args.weekStart, args.kfiId, args.punchId, args.userId),
  );
  publish({
    type: "editing",
    weekStart: args.weekStart,
    kfiId: args.kfiId,
    punchId: args.punchId,
    actor: { userId: args.userId, email: args.email },
    action: "stop",
    expiresAt: nowIso(Date.now()),
  });
}

export interface RealtimeSnapshot {
  clientCount: number;
  presenceCount: number;
  editingCount: number;
  clients: Array<{
    id: string;
    userId: number;
    email: string;
    weekStart: string;
    kfiId: string | null;
    connectedAgoMs: number;
  }>;
  presence: Array<{
    userId: number;
    email: string;
    weekStart: string;
    kfiId: string | null;
    lastSeenAgoMs: number;
  }>;
  editing: Array<{
    weekStart: string;
    kfiId: string;
    punchId: number | null;
    userId: number;
    email: string;
    expiresInMs: number;
  }>;
}

export function snapshot(): RealtimeSnapshot {
  pruneExpired();
  const nowMs = Date.now();
  return {
    clientCount: clients.size,
    presenceCount: presence.size,
    editingCount: editing.size,
    clients: [...clients.values()].map((c) => ({
      id: c.id,
      userId: c.userId,
      email: c.email,
      weekStart: c.weekStart,
      kfiId: c.kfiId,
      connectedAgoMs: nowMs - c.connectedAt,
    })),
    presence: [...presence.values()].map((p) => ({
      userId: p.userId,
      email: p.email,
      weekStart: p.weekStart,
      kfiId: p.kfiId,
      lastSeenAgoMs: nowMs - p.lastSeenAt,
    })),
    editing: [...editing.values()].map((e) => ({
      weekStart: e.weekStart,
      kfiId: e.kfiId,
      punchId: e.punchId,
      userId: e.userId,
      email: e.email,
      expiresInMs: e.expiresAt - nowMs,
    })),
  };
}

// Periodic ping so reverse-proxies don't kill idle SSE connections, and so
// we get a chance to prune stale presence/editing entries.
let heartbeatHandle: NodeJS.Timeout | null = null;
export function startRealtimeHeartbeat(): void {
  if (heartbeatHandle) return;
  heartbeatHandle = setInterval(() => {
    pruneExpired();
    for (const rec of clients.values()) {
      writeSse(rec.res, { type: "ping" });
    }
  }, 20_000);
  heartbeatHandle.unref?.();
}

export function stopRealtimeHeartbeat(): void {
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

// Test-only: reset all in-memory state.
export function _resetForTests(): void {
  clients.clear();
  presence.clear();
  editing.clear();
}
