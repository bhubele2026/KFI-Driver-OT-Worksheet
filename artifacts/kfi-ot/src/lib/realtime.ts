// Client-side SSE singleton + typed event bus. Each subscription is keyed
// by (weekStart, kfiId?) and we re-use one EventSource per key so multiple
// hooks on the same page share a single network connection.
//
// We mount once, listen for "data:" frames, parse JSON, and fan out to
// every registered handler. The hub auto-reconnects with backoff on error.

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
  | { type: "week-refreshed"; weekStart: string; actor: ActorRef | null }
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
  | { type: "presence"; weekStart: string; viewers: PresenceViewer[] }
  | {
      type: "editing";
      weekStart: string;
      kfiId: string;
      punchId: number | null;
      actor: ActorRef;
      action: "start" | "stop";
      expiresAt: string;
    }
  | { type: "ping" }
  | { type: "reconnect"; weekStart: string; kfiId: string | null };

type Handler = (event: RealtimeEvent) => void;

interface Subscription {
  weekStart: string;
  kfiId: string | null;
  handler: Handler;
}

interface ConnectionRec {
  key: string;
  weekStart: string;
  kfiId: string | null;
  source: EventSource;
  refCount: number;
  retryDelayMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  handlers: Set<Handler>;
  // True once we've ever connected successfully on this rec, so a subsequent
  // onopen is recognized as a reconnect (even when EventSource auto-recovers
  // CONNECTING → OPEN without us forcing a recycle).
  everOpened: boolean;
  // Flipped on onerror; consumed on next onopen to fire a synthetic
  // "reconnect" event for query resync.
  hadDisconnect: boolean;
}

const apiBase = `${import.meta.env.BASE_URL}api`;

// Skip realtime under headless automation (Playwright/CI) so e2e specs that
// use page.waitForLoadState("networkidle") don't hang on the long-lived SSE
// connection. Real browsers set webdriver=false; Playwright chromium sets it
// to true. The dispatcher experience is unaffected.
const REALTIME_DISABLED =
  typeof navigator !== "undefined" && (navigator as Navigator).webdriver === true;

const connections = new Map<string, ConnectionRec>();

function connKey(weekStart: string, kfiId: string | null): string {
  return `${weekStart}|${kfiId ?? ""}`;
}

function openConnection(weekStart: string, kfiId: string | null): ConnectionRec {
  const key = connKey(weekStart, kfiId);
  const existing = connections.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }
  const rec: ConnectionRec = {
    key,
    weekStart,
    kfiId,
    source: createSource(weekStart, kfiId),
    refCount: 1,
    retryDelayMs: 1000,
    retryTimer: null,
    handlers: new Set(),
    everOpened: false,
    hadDisconnect: false,
  };
  attach(rec);
  connections.set(key, rec);
  return rec;
}

function createSource(weekStart: string, kfiId: string | null): EventSource {
  const url = new URL(`${apiBase}/events`, window.location.origin);
  url.searchParams.set("weekStart", weekStart);
  if (kfiId) url.searchParams.set("kfiId", kfiId);
  return new EventSource(url.toString(), { withCredentials: true });
}

function attach(rec: ConnectionRec, isReconnect = false): void {
  rec.source.onopen = () => {
    // Treat any open after the very first as a reconnect. This covers both
    // (a) our forced recycle path (CLOSED → new EventSource) and (b) the
    // browser's built-in EventSource auto-recovery (CONNECTING → OPEN after
    // a transient network blip), so subscribers always get a resync signal
    // when the stream was interrupted.
    const reconnected = isReconnect || rec.hadDisconnect || rec.everOpened;
    rec.everOpened = true;
    rec.hadDisconnect = false;
    isReconnect = false;
    if (reconnected) {
      const evt: RealtimeEvent = {
        type: "reconnect",
        weekStart: rec.weekStart,
        kfiId: rec.kfiId,
      };
      for (const h of rec.handlers) {
        try {
          h(evt);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("realtime reconnect handler threw", err);
        }
      }
    }
  };
  rec.source.onmessage = (e) => {
    if (!e.data) return;
    try {
      const event = JSON.parse(e.data) as RealtimeEvent;
      if (event.type === "ping") return;
      // Reset backoff on first successful frame.
      rec.retryDelayMs = 1000;
      for (const h of rec.handlers) {
        try {
          h(event);
        } catch (err) {
          // Don't let a buggy handler take down the entire fan-out.
          // eslint-disable-next-line no-console
          console.error("realtime handler threw", err);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("realtime parse failed", err);
    }
  };
  rec.source.onerror = () => {
    // Mark that we lost the connection; the next successful onopen (whether
    // from browser auto-recovery or our forced recycle) will fire the
    // reconnect resync.
    rec.hadDisconnect = true;
    // EventSource auto-reconnects, but on certain failure modes (auth
    // expiry, etc.) it stays in CLOSED. Force a manual recycle with
    // bounded backoff so a single dropped network doesn't leave the page
    // permanently stale.
    if (rec.source.readyState === EventSource.CLOSED && rec.refCount > 0) {
      if (rec.retryTimer) return;
      const delay = Math.min(rec.retryDelayMs, 15_000);
      rec.retryTimer = setTimeout(() => {
        rec.retryTimer = null;
        rec.retryDelayMs = Math.min(rec.retryDelayMs * 2, 15_000);
        try {
          rec.source.close();
        } catch {
          /* ignore */
        }
        rec.source = createSource(rec.weekStart, rec.kfiId);
        attach(rec, true);
      }, delay);
    }
  };
}

function release(rec: ConnectionRec): void {
  rec.refCount -= 1;
  if (rec.refCount > 0) return;
  if (rec.retryTimer) clearTimeout(rec.retryTimer);
  try {
    rec.source.close();
  } catch {
    /* ignore */
  }
  connections.delete(rec.key);
}

export function subscribeRealtime(sub: Subscription): () => void {
  if (REALTIME_DISABLED) return () => {};
  const rec = openConnection(sub.weekStart, sub.kfiId);
  rec.handlers.add(sub.handler);
  return () => {
    rec.handlers.delete(sub.handler);
    release(rec);
  };
}

export async function postPresence(weekStart: string, kfiId: string | null): Promise<void> {
  if (REALTIME_DISABLED) return;
  await fetch(`${apiBase}/presence`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weekStart, kfiId }),
  }).catch(() => {
    // Presence is a best-effort heartbeat; a transient failure self-heals
    // on the next interval.
  });
}

export async function postEditing(args: {
  weekStart: string;
  kfiId: string;
  punchId: number | null;
  action: "start" | "stop";
}): Promise<void> {
  if (REALTIME_DISABLED) return;
  await fetch(`${apiBase}/editing`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  }).catch(() => {
    /* best-effort */
  });
}
