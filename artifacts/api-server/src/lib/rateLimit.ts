import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Pool } from "pg";

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; retryAfterSec: number; resetAt: number };

export interface Limiter {
  check(key: string): Promise<RateLimitResult>;
  consume(key: string): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

interface BucketRow {
  count: number;
  resetAt: number;
}

/**
 * Storage backend for rate-limit buckets. The default in-memory backend is
 * fine for tests and single-process dev, but production should swap in the
 * Postgres backend so that buckets persist across restarts and are shared
 * across API instances.
 */
export interface RateLimitBackend {
  /** Read the current bucket without mutating it. */
  peek(name: string, key: string): Promise<BucketRow | null>;
  /**
   * Atomically increment the bucket's count by 1. If the existing bucket has
   * already expired (or no bucket exists), start a fresh window of `windowMs`.
   * Returns the post-increment count and the window's reset timestamp.
   *
   * The backend MAY allow `count` to climb past `max` under contention; the
   * caller treats `count > max` as "denied". Buckets are bounded in size by
   * `windowMs` (they expire and get cleaned up), so a small over-count from
   * concurrent increments is acceptable.
   */
  increment(
    name: string,
    key: string,
    windowMs: number,
  ): Promise<BucketRow>;
  reset(name: string, key: string): Promise<void>;
}

// ---------------- Memory backend (default) ----------------

function createMemoryBackend(): RateLimitBackend {
  const stores = new Map<string, Map<string, BucketRow>>();
  function getStore(name: string): Map<string, BucketRow> {
    let s = stores.get(name);
    if (!s) {
      s = new Map();
      stores.set(name, s);
    }
    return s;
  }
  function sweep(store: Map<string, BucketRow>, now: number) {
    if (store.size < 1024) return;
    for (const [k, v] of store) {
      if (v.resetAt <= now) store.delete(k);
    }
  }
  return {
    async peek(name, key) {
      const store = getStore(name);
      const b = store.get(key);
      return b ? { count: b.count, resetAt: b.resetAt } : null;
    },
    async increment(name, key, windowMs) {
      const now = Date.now();
      const store = getStore(name);
      sweep(store, now);
      let b = store.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowMs };
        store.set(key, b);
      }
      b.count += 1;
      return { count: b.count, resetAt: b.resetAt };
    },
    async reset(name, key) {
      getStore(name).delete(key);
    },
  };
}

// ---------------- Postgres backend ----------------

/**
 * Postgres-backed bucket store. One row per (name, key); atomic upsert
 * increments via ON CONFLICT, restarting the window if the prior one expired.
 */
export function createPostgresBackend(pool: Pool): RateLimitBackend {
  return {
    async peek(name, key) {
      const r = await pool.query<{ count: number; reset_at: Date }>(
        `SELECT count, reset_at FROM rate_limit_buckets WHERE name = $1 AND key = $2`,
        [name, key],
      );
      const row = r.rows[0];
      if (!row) return null;
      return { count: Number(row.count), resetAt: row.reset_at.getTime() };
    },
    async increment(name, key, windowMs) {
      const newReset = new Date(Date.now() + windowMs);
      const r = await pool.query<{ count: number; reset_at: Date }>(
        `INSERT INTO rate_limit_buckets (name, key, count, reset_at)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (name, key) DO UPDATE SET
           count = CASE
             WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
             ELSE rate_limit_buckets.count + 1
           END,
           reset_at = CASE
             WHEN rate_limit_buckets.reset_at <= NOW() THEN EXCLUDED.reset_at
             ELSE rate_limit_buckets.reset_at
           END
         RETURNING count, reset_at`,
        [name, key, newReset],
      );
      const row = r.rows[0];
      return { count: Number(row.count), resetAt: row.reset_at.getTime() };
    },
    async reset(name, key) {
      await pool.query(
        `DELETE FROM rate_limit_buckets WHERE name = $1 AND key = $2`,
        [name, key],
      );
    },
  };
}

/**
 * Periodically delete expired buckets so the table stays bounded. Returns the
 * timer handle so callers can clear it on shutdown if needed.
 */
export function startPostgresBackendCleanup(
  pool: Pool,
  opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  const timer = setInterval(() => {
    pool
      .query(`DELETE FROM rate_limit_buckets WHERE reset_at <= NOW()`)
      .catch((err) => {
        opts.onError?.(err);
      });
  }, intervalMs);
  // Don't keep the event loop alive solely for cleanup.
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

// ---------------- Backend selection ----------------

let backend: RateLimitBackend = createMemoryBackend();

/** Swap the backend used by all limiters. Call once at server bootstrap. */
export function setRateLimitBackend(b: RateLimitBackend): void {
  backend = b;
}

function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? "unknown").toString();
}

export function createLimiter(opts: {
  name: string;
  windowMs: number;
  max: number;
}): Limiter {
  const { name, windowMs, max } = opts;
  return {
    async check(key) {
      const now = Date.now();
      const row = await backend.peek(name, key);
      if (!row || row.resetAt <= now) {
        return { ok: true, remaining: max, resetAt: now + windowMs };
      }
      if (row.count >= max) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((row.resetAt - now) / 1000)),
          resetAt: row.resetAt,
        };
      }
      return { ok: true, remaining: max - row.count, resetAt: row.resetAt };
    },
    async consume(key) {
      const { count, resetAt } = await backend.increment(name, key, windowMs);
      const now = Date.now();
      if (count > max) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
          resetAt,
        };
      }
      return { ok: true, remaining: max - count, resetAt };
    },
    async reset(key) {
      await backend.reset(name, key);
    },
  };
}

function denyResponse(res: Response, retryAfterSec: number, message: string) {
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({ error: message, retryAfterSec });
}

/**
 * Per-IP middleware that consumes one token per request. Use for endpoints
 * where every hit is an attack-cost (token enumeration, reset-spam).
 */
export function ipRateLimit(opts: {
  name: string;
  windowMs: number;
  max: number;
  message?: string;
}): RequestHandler {
  const limiter = createLimiter(opts);
  const message =
    opts.message ?? "Too many requests. Please wait before trying again.";
  return (req: Request, res: Response, next: NextFunction) => {
    limiter.consume(`ip:${clientIp(req)}`).then(
      (result) => {
        if (!result.ok) {
          req.log?.warn(
            { limiter: opts.name, ip: clientIp(req) },
            "rate limit exceeded",
          );
          denyResponse(res, result.retryAfterSec, message);
          return;
        }
        next();
      },
      (err) => next(err),
    );
  };
}

/** Limiter for login: keyed per-IP and per-email, only consumed on failure. */
export const loginIpLimiter = createLimiter({
  name: "login:ip",
  windowMs: 15 * 60 * 1000,
  max: 20,
});

export const loginEmailLimiter = createLimiter({
  name: "login:email",
  windowMs: 15 * 60 * 1000,
  max: 5,
});

export async function checkLoginLimits(
  req: Request,
  res: Response,
  email: string | null,
): Promise<boolean> {
  const ip = clientIp(req);
  const ipCheck = await loginIpLimiter.check(`ip:${ip}`);
  if (!ipCheck.ok) {
    req.log?.warn({ ip }, "login rate limit (ip) exceeded");
    denyResponse(
      res,
      ipCheck.retryAfterSec,
      "Too many failed sign-in attempts from your network. Please wait and try again.",
    );
    return false;
  }
  if (email) {
    const emailCheck = await loginEmailLimiter.check(`email:${email}`);
    if (!emailCheck.ok) {
      req.log?.warn({ email }, "login rate limit (email) exceeded");
      denyResponse(
        res,
        emailCheck.retryAfterSec,
        "Too many failed sign-in attempts for this account. Please wait and try again.",
      );
      return false;
    }
  }
  return true;
}

export async function recordLoginFailure(
  req: Request,
  email: string | null,
): Promise<void> {
  const ip = clientIp(req);
  await loginIpLimiter.consume(`ip:${ip}`);
  if (email) await loginEmailLimiter.consume(`email:${email}`);
}

export async function recordLoginSuccess(
  _req: Request,
  email: string | null,
): Promise<void> {
  // Intentionally do NOT reset the per-IP bucket: an attacker who controls
  // (or guesses) one valid account could otherwise clear their IP-level
  // failure history and continue brute-forcing other accounts from the same
  // network. IP failures expire naturally with the window.
  if (email) await loginEmailLimiter.reset(`email:${email}`);
}

export const __testing = {
  createMemoryBackend,
  setRateLimitBackend,
};
