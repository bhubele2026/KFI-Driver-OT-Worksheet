import type { Request, Response, NextFunction, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "./db.js";
import { logger } from "./logger.js";

// In-process snapshot of the ip_blocklist table. The middleware consults this
// Set once per request — no DB round-trip on the hot path. The cache refreshes
// on a timer and is bumped synchronously whenever an admin adds or removes an
// entry, so even on a multi-instance deploy the worst-case staleness for the
// instances that didn't receive the write is `REFRESH_MS`.
const REFRESH_MS = 30 * 1000;

let cache: Set<string> = new Set();
let lastLoadedAt = 0;
let inflight: Promise<void> | null = null;

async function loadBlocklist(): Promise<void> {
  const rows = await db
    .select({ ip: schema.ipBlocklistTable.ip })
    .from(schema.ipBlocklistTable);
  cache = new Set(rows.map((r) => r.ip));
  lastLoadedAt = Date.now();
}

/** Force a synchronous reload — call after admin add/remove. */
export async function refreshBlocklist(): Promise<void> {
  await loadBlocklist();
}

async function ensureFresh(): Promise<void> {
  if (Date.now() - lastLoadedAt < REFRESH_MS) return;
  if (inflight) return inflight;
  inflight = loadBlocklist()
    .catch((err) => {
      // Fail open on a transient DB hiccup: better to let traffic through
      // than to 500 every request because we couldn't refresh the cache.
      // The next tick will retry. We push lastLoadedAt forward so we don't
      // hammer a dead DB on every request.
      lastLoadedAt = Date.now();
      logger.warn({ err }, "ip blocklist refresh failed");
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? "unknown").toString();
}

export function isBlockedSync(ip: string): boolean {
  return cache.has(ip);
}

export const ipBlocklistMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  ensureFresh().then(
    () => {
      const ip = clientIp(req);
      if (cache.has(ip)) {
        req.log?.warn({ ip, path: req.path }, "blocked ip rejected");
        res.status(403).json({
          error: "Your network address has been blocked. Contact an admin.",
        });
        return;
      }
      next();
    },
    (err) => next(err),
  );
};

export interface BlocklistEntry {
  ip: string;
  reason: string | null;
  createdAt: Date;
  createdByUserId: number | null;
  createdByEmail: string | null;
}

export async function listBlocklist(): Promise<BlocklistEntry[]> {
  const rows = await db
    .select({
      ip: schema.ipBlocklistTable.ip,
      reason: schema.ipBlocklistTable.reason,
      createdAt: schema.ipBlocklistTable.createdAt,
      createdByUserId: schema.ipBlocklistTable.createdByUserId,
      createdByEmail: schema.usersTable.email,
    })
    .from(schema.ipBlocklistTable)
    .leftJoin(
      schema.usersTable,
      eq(schema.usersTable.id, schema.ipBlocklistTable.createdByUserId),
    )
    .orderBy(schema.ipBlocklistTable.createdAt);
  return rows.map((r) => ({
    ip: r.ip,
    reason: r.reason,
    createdAt: r.createdAt,
    createdByUserId: r.createdByUserId,
    createdByEmail: r.createdByEmail ?? null,
  }));
}

export async function addToBlocklist(
  ip: string,
  reason: string | null,
  createdByUserId: number,
): Promise<void> {
  await db
    .insert(schema.ipBlocklistTable)
    .values({ ip, reason, createdByUserId })
    .onConflictDoUpdate({
      target: schema.ipBlocklistTable.ip,
      set: { reason, createdByUserId, createdAt: new Date() },
    });
  await refreshBlocklist();
}

export async function removeFromBlocklist(ip: string): Promise<void> {
  await db
    .delete(schema.ipBlocklistTable)
    .where(eq(schema.ipBlocklistTable.ip, ip));
  await refreshBlocklist();
}

/** Hydrate the cache at server boot so the first request isn't a cache miss. */
export async function initIpBlocklist(): Promise<void> {
  await loadBlocklist();
}
