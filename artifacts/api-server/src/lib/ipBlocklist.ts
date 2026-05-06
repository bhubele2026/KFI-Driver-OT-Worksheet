import type { Request, Response, NextFunction, RequestHandler } from "express";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { eq } from "drizzle-orm";
import { db, schema } from "./db.js";
import { logger } from "./logger.js";

// In-process snapshot of the ip_blocklist table. The middleware consults this
// BlockList once per request — no DB round-trip on the hot path. The cache
// refreshes on a timer and is bumped synchronously whenever an admin adds or
// removes an entry, so even on a multi-instance deploy the worst-case staleness
// for the instances that didn't receive the write is `REFRESH_MS`.
const REFRESH_MS = 30 * 1000;

interface ParsedEntry {
  raw: string;
  family: "ipv4" | "ipv6";
  isCidr: boolean;
  address: string;
  prefix: number | null;
}

/**
 * Parse a blocklist entry as either a single IP (v4/v6) or a CIDR range
 * (e.g. `203.0.113.0/24`, `2001:db8::/32`). Returns null for anything else.
 */
export function parseBlocklistEntry(input: string): ParsedEntry | null {
  const entry = input.trim();
  if (!entry) return null;
  const slash = entry.indexOf("/");
  if (slash === -1) {
    if (isIPv4(entry)) {
      return { raw: entry, family: "ipv4", isCidr: false, address: entry, prefix: null };
    }
    if (isIPv6(entry)) {
      return { raw: entry, family: "ipv6", isCidr: false, address: entry, prefix: null };
    }
    return null;
  }
  const addr = entry.slice(0, slash);
  const pfxStr = entry.slice(slash + 1);
  if (!/^\d+$/.test(pfxStr)) return null;
  const pfx = Number(pfxStr);
  if (isIPv4(addr)) {
    if (pfx < 0 || pfx > 32) return null;
    return { raw: entry, family: "ipv4", isCidr: true, address: addr, prefix: pfx };
  }
  if (isIPv6(addr)) {
    if (pfx < 0 || pfx > 128) return null;
    return { raw: entry, family: "ipv6", isCidr: true, address: addr, prefix: pfx };
  }
  return null;
}

let blockList = new BlockList();
let cachedRaw: string[] = [];
let lastLoadedAt = 0;
let inflight: Promise<void> | null = null;

function rebuild(entries: string[]): void {
  const bl = new BlockList();
  for (const raw of entries) {
    const p = parseBlocklistEntry(raw);
    if (!p) {
      logger.warn({ entry: raw }, "ignoring invalid ip blocklist entry");
      continue;
    }
    if (p.isCidr) {
      bl.addSubnet(p.address, p.prefix!, p.family);
    } else {
      bl.addAddress(p.address, p.family);
    }
  }
  blockList = bl;
  cachedRaw = entries;
}

async function loadBlocklist(): Promise<void> {
  const rows = await db
    .select({ ip: schema.ipBlocklistTable.ip })
    .from(schema.ipBlocklistTable);
  rebuild(rows.map((r) => r.ip));
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

function normalizeIp(
  ip: string,
): { addr: string; family: "ipv4" | "ipv6" } | null {
  let a = ip;
  // IPv4-mapped IPv6 addresses (e.g. `::ffff:1.2.3.4`) — strip the prefix so
  // they match v4 entries naturally.
  if (a.startsWith("::ffff:") && isIPv4(a.slice(7))) a = a.slice(7);
  if (isIPv4(a)) return { addr: a, family: "ipv4" };
  if (isIPv6(a)) return { addr: a, family: "ipv6" };
  return null;
}

export function isBlockedSync(ip: string): boolean {
  const n = normalizeIp(ip);
  if (!n) return false;
  return blockList.check(n.addr, n.family);
}

/**
 * Does the given parsed entry match `ip`? Used by the add-blocklist route
 * to refuse self-lockout, including when admins try to block a CIDR that
 * contains their own current IP.
 */
export function entryMatchesIp(
  entry: ReturnType<typeof parseBlocklistEntry>,
  ip: string,
): boolean {
  if (!entry) return false;
  const n = normalizeIp(ip);
  if (!n) return false;
  const bl = new BlockList();
  if (entry.isCidr) bl.addSubnet(entry.address, entry.prefix!, entry.family);
  else bl.addAddress(entry.address, entry.family);
  return bl.check(n.addr, n.family);
}

export const ipBlocklistMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  ensureFresh().then(
    () => {
      const ip = clientIp(req);
      if (isBlockedSync(ip)) {
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

/** Exposed for tests / debugging. */
export function _getCachedEntries(): string[] {
  return [...cachedRaw];
}
