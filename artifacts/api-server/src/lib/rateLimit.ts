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

/**
 * Periodically delete rate_limit_events rows older than ~90 days so the
 * append-only audit table stays bounded. Modeled on
 * `startPostgresBackendCleanup`. Returns the timer handle so callers can
 * clear it on shutdown if needed.
 */
export function startRateLimitEventsCleanup(
  pool: Pool,
  opts: {
    intervalMs?: number;
    retentionDays?: number;
    onError?: (err: unknown) => void;
  } = {},
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
  const retentionDays = opts.retentionDays ?? 90;
  const timer = setInterval(() => {
    pool
      .query(
        `DELETE FROM rate_limit_events
         WHERE blocked_at < NOW() - ($1 || ' days')::interval`,
        [String(retentionDays)],
      )
      .catch((err) => {
        opts.onError?.(err);
      });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

// ---------------- Backend selection ----------------

let backend: RateLimitBackend = createMemoryBackend();

/** Swap the backend used by all limiters. Call once at server bootstrap. */
export function setRateLimitBackend(b: RateLimitBackend): void {
  backend = b;
}

// ---------------- Event logging ----------------

/**
 * Optional sink invoked once per "transition to blocked" event — i.e. the
 * first increment that takes a bucket's count to (or past) its limiter's
 * `max`. Subsequent denials inside the same window do NOT re-fire. The sink
 * is best-effort and must not throw; failures should be swallowed so a
 * persistence hiccup never breaks the user-facing rate-limit response.
 */
export type RateLimitEventSink = (event: {
  name: string;
  key: string;
  blockedAt: Date;
  expiredAt: Date;
}) => void;

let eventSink: RateLimitEventSink | null = null;

export function setRateLimitEventSink(sink: RateLimitEventSink | null): void {
  eventSink = sink;
}

// ---------------- Limiter registry ----------------

interface RegisteredLimiter {
  name: string;
  windowMs: number;
  max: number;
}

const registry = new Map<string, RegisteredLimiter>();

export function getRegisteredLimiters(): RegisteredLimiter[] {
  return Array.from(registry.values());
}

export interface ActiveBucket {
  name: string;
  key: string;
  count: number;
  max: number;
  windowMs: number;
  resetAt: number;
  blocked: boolean;
}

/**
 * Return all currently-tracked buckets (those whose window has not yet
 * expired) joined with their limiter's max/window. Buckets whose limiter is no
 * longer registered (e.g. renamed across a deploy) are still surfaced with
 * `max=0` and `blocked=true` so admins can see and clear them.
 *
 * Reads `rate_limit_buckets` directly because the Postgres backend is the only
 * one used in production; the in-memory backend is for tests.
 */
export async function listActiveBuckets(
  pool: Pool,
  opts: { limit?: number } = {},
): Promise<ActiveBucket[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const r = await pool.query<{
    name: string;
    key: string;
    count: number;
    reset_at: Date;
  }>(
    `SELECT name, key, count, reset_at
     FROM rate_limit_buckets
     WHERE reset_at > NOW()
     ORDER BY count DESC, reset_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => {
    const reg = registry.get(row.name);
    const max = reg?.max ?? 0;
    const count = Number(row.count);
    return {
      name: row.name,
      key: row.key,
      count,
      max,
      windowMs: reg?.windowMs ?? 0,
      resetAt: row.reset_at.getTime(),
      blocked: max > 0 ? count >= max : true,
    };
  });
}

export async function clearBucket(name: string, key: string): Promise<void> {
  await backend.reset(name, key);
}

export interface RecentLockout {
  name: string;
  key: string;
  count: number;
  lastBlockedAt: number;
  firstBlockedAt: number;
}

/**
 * Aggregate recent rate-limit lockouts grouped by (name, key). Used by the
 * admin Security activity panel to spot repeat offenders even after their
 * live bucket has expired and disappeared from `rate_limit_buckets`.
 */
export async function listRecentLockouts(
  pool: Pool,
  opts: { sinceMs?: number; limit?: number } = {},
): Promise<RecentLockout[]> {
  const sinceMs = opts.sinceMs ?? 7 * 24 * 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const since = new Date(Date.now() - sinceMs);
  const r = await pool.query<{
    name: string;
    key: string;
    count: string;
    last_blocked_at: Date;
    first_blocked_at: Date;
  }>(
    `SELECT name, key, COUNT(*)::text AS count,
            MAX(blocked_at) AS last_blocked_at,
            MIN(blocked_at) AS first_blocked_at
     FROM rate_limit_events
     WHERE blocked_at >= $1
     GROUP BY name, key
     ORDER BY MAX(blocked_at) DESC
     LIMIT $2`,
    [since, limit],
  );
  return r.rows.map((row) => ({
    name: row.name,
    key: row.key,
    count: Number(row.count),
    lastBlockedAt: row.last_blocked_at.getTime(),
    firstBlockedAt: row.first_blocked_at.getTime(),
  }));
}

export interface LockoutTimeseriesPoint {
  /** ISO date `YYYY-MM-DD` (UTC day boundary). */
  day: string;
  /** Limiter name (e.g. `login:ip`). */
  name: string;
  /** Number of lockout events that fired in this bucket. */
  count: number;
}

/**
 * Daily lockout counts grouped by limiter name, padded so every (day, name)
 * pair in the window has a row even when the count is zero. Used by the
 * admin Security panel chart so trendlines and gaps are visually obvious.
 */
export async function listLockoutTimeseries(
  pool: Pool,
  opts: { days?: number } = {},
): Promise<LockoutTimeseriesPoint[]> {
  const days = Math.max(1, Math.min(90, opts.days ?? 7));
  // Anchor "today" to the UTC day boundary so the same row count comes back
  // regardless of when in the day the request fires.
  const todayUtcMs = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const startMs = todayUtcMs - (days - 1) * 86_400_000;
  const since = new Date(startMs);
  const r = await pool.query<{
    day: Date;
    name: string;
    count: string;
  }>(
    `SELECT date_trunc('day', blocked_at AT TIME ZONE 'UTC') AS day,
            name,
            COUNT(*)::text AS count
     FROM rate_limit_events
     WHERE blocked_at >= $1
     GROUP BY 1, 2
     ORDER BY 1 ASC`,
    [since],
  );
  // Build a (day, name) -> count map plus the set of limiter names that
  // actually showed up, so we can pad zeros only for relevant series.
  const counts = new Map<string, number>();
  const names = new Set<string>();
  for (const row of r.rows) {
    const day = isoDay(row.day);
    counts.set(`${day}::${row.name}`, Number(row.count));
    names.add(row.name);
  }
  const out: LockoutTimeseriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const day = isoDay(new Date(startMs + i * 86_400_000));
    for (const name of names) {
      out.push({ day, name, count: counts.get(`${day}::${name}`) ?? 0 });
    }
  }
  return out;
}

function isoDay(d: Date): string {
  // YYYY-MM-DD in UTC.
  return d.toISOString().slice(0, 10);
}

export interface LockoutTopOffender {
  /** ISO date `YYYY-MM-DD` (UTC day boundary). */
  day: string;
  name: string;
  key: string;
  count: number;
  firstBlockedAt: number;
  lastBlockedAt: number;
}

/**
 * For each UTC day in the window, return the top-N (limiter, key) pairs by
 * lockout count. Used by the admin Security panel so admins can go from a
 * spike on the chart straight to the IPs/emails that drove it without
 * eyeballing the full table.
 */
export async function listLockoutTopOffenders(
  pool: Pool,
  opts: { days?: number; perDay?: number } = {},
): Promise<LockoutTopOffender[]> {
  const days = Math.max(1, Math.min(90, opts.days ?? 7));
  const perDay = Math.max(1, Math.min(20, opts.perDay ?? 3));
  const todayUtcMs = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const startMs = todayUtcMs - (days - 1) * 86_400_000;
  const since = new Date(startMs);
  const r = await pool.query<{
    day: Date;
    name: string;
    key: string;
    count: string;
    first_blocked_at: Date;
    last_blocked_at: Date;
  }>(
    `WITH per_day AS (
       SELECT date_trunc('day', blocked_at AT TIME ZONE 'UTC') AS day,
              name, key, COUNT(*) AS count,
              MIN(blocked_at) AS first_blocked_at,
              MAX(blocked_at) AS last_blocked_at
       FROM rate_limit_events
       WHERE blocked_at >= $1
       GROUP BY 1, 2, 3
     ), ranked AS (
       SELECT day, name, key, count, first_blocked_at, last_blocked_at,
              ROW_NUMBER() OVER (
                PARTITION BY day
                ORDER BY count DESC, last_blocked_at DESC, name ASC, key ASC
              ) AS rn
       FROM per_day
     )
     SELECT day, name, key, count::text AS count,
            first_blocked_at, last_blocked_at
     FROM ranked
     WHERE rn <= $2
     ORDER BY day DESC, count DESC, last_blocked_at DESC`,
    [since, perDay],
  );
  return r.rows.map((row) => ({
    day: isoDay(row.day),
    name: row.name,
    key: row.key,
    count: Number(row.count),
    firstBlockedAt: row.first_blocked_at.getTime(),
    lastBlockedAt: row.last_blocked_at.getTime(),
  }));
}

export interface SuggestedIpBlock {
  ip: string;
  lockoutCount: number;
  firstBlockedAt: number;
  lastBlockedAt: number;
  limiters: string[];
}

/**
 * Aggregate IP-keyed lockouts in a recent window into "suggested blocks".
 * Returns IPs that have hit at least `minLockouts` lockouts (across any
 * limiters) since `sinceMs` ago and are NOT already on the blocklist. Used
 * by the admin Security activity panel to surface repeat offenders without
 * making the admin eyeball the table.
 */
export async function listSuggestedIpBlocks(
  pool: Pool,
  opts: {
    sinceMs?: number;
    minLockouts?: number;
    excludeIps?: Iterable<string>;
    limit?: number;
  } = {},
): Promise<SuggestedIpBlock[]> {
  const sinceMs = opts.sinceMs ?? 24 * 60 * 60 * 1000;
  const minLockouts = Math.max(1, opts.minLockouts ?? 3);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const since = new Date(Date.now() - sinceMs);
  // Exclude blocklisted IPs in SQL (before LIMIT) so the response always
  // contains the top eligible non-blocklisted offenders even when the busiest
  // IPs in the window are already blocked.
  const excludedArr = Array.from(new Set(opts.excludeIps ?? []));
  const r = await pool.query<{
    ip: string;
    lockout_count: string;
    first_blocked_at: Date;
    last_blocked_at: Date;
    limiters: string[];
  }>(
    `SELECT
       substr(key, 4) AS ip,
       COUNT(*)::text AS lockout_count,
       MIN(blocked_at) AS first_blocked_at,
       MAX(blocked_at) AS last_blocked_at,
       ARRAY_AGG(DISTINCT name ORDER BY name) AS limiters
     FROM rate_limit_events
     WHERE blocked_at >= $1
       AND key LIKE 'ip:%'
       AND NOT (substr(key, 4) = ANY($4::text[]))
     GROUP BY substr(key, 4)
     HAVING COUNT(*) >= $2
     ORDER BY MAX(blocked_at) DESC
     LIMIT $3`,
    [since, minLockouts, limit, excludedArr],
  );
  return r.rows.map((row) => ({
    ip: row.ip,
    lockoutCount: Number(row.lockout_count),
    firstBlockedAt: row.first_blocked_at.getTime(),
    lastBlockedAt: row.last_blocked_at.getTime(),
    limiters: row.limiters,
  }));
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
  registry.set(name, { name, windowMs, max });
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
      // Fire the event sink exactly once per window, on the increment that
      // first crosses the threshold. With +1 increments that's count == max.
      if (count === max && eventSink) {
        try {
          eventSink({
            name,
            key,
            blockedAt: new Date(now),
            expiredAt: new Date(resetAt),
          });
        } catch {
          // Sink errors must not affect the request path.
        }
      }
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
