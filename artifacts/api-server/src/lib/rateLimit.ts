import type { Request, Response, NextFunction, RequestHandler } from "express";

type Bucket = { count: number; resetAt: number };

const stores = new Map<string, Map<string, Bucket>>();

function getStore(name: string): Map<string, Bucket> {
  let s = stores.get(name);
  if (!s) {
    s = new Map();
    stores.set(name, s);
  }
  return s;
}

function sweep(store: Map<string, Bucket>, now: number) {
  if (store.size < 1024) return;
  for (const [k, v] of store) {
    if (v.resetAt <= now) store.delete(k);
  }
}

function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? "unknown").toString();
}

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; retryAfterSec: number; resetAt: number };

export interface Limiter {
  check(key: string): RateLimitResult;
  consume(key: string): RateLimitResult;
  reset(key: string): void;
}

export function createLimiter(opts: {
  name: string;
  windowMs: number;
  max: number;
}): Limiter {
  const { name, windowMs, max } = opts;
  const store = getStore(name);
  return {
    check(key) {
      const now = Date.now();
      const b = store.get(key);
      if (!b || b.resetAt <= now) {
        return { ok: true, remaining: max, resetAt: now + windowMs };
      }
      if (b.count >= max) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
          resetAt: b.resetAt,
        };
      }
      return { ok: true, remaining: max - b.count, resetAt: b.resetAt };
    },
    consume(key) {
      const now = Date.now();
      sweep(store, now);
      let b = store.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowMs };
        store.set(key, b);
      }
      if (b.count >= max) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
          resetAt: b.resetAt,
        };
      }
      b.count += 1;
      return { ok: true, remaining: max - b.count, resetAt: b.resetAt };
    },
    reset(key) {
      store.delete(key);
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
    const result = limiter.consume(`ip:${clientIp(req)}`);
    if (!result.ok) {
      req.log?.warn(
        { limiter: opts.name, ip: clientIp(req) },
        "rate limit exceeded",
      );
      denyResponse(res, result.retryAfterSec, message);
      return;
    }
    next();
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

export function checkLoginLimits(
  req: Request,
  res: Response,
  email: string | null,
): boolean {
  const ip = clientIp(req);
  const ipCheck = loginIpLimiter.check(`ip:${ip}`);
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
    const emailCheck = loginEmailLimiter.check(`email:${email}`);
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

export function recordLoginFailure(req: Request, email: string | null) {
  const ip = clientIp(req);
  loginIpLimiter.consume(`ip:${ip}`);
  if (email) loginEmailLimiter.consume(`email:${email}`);
}

export function recordLoginSuccess(_req: Request, email: string | null) {
  // Intentionally do NOT reset the per-IP bucket: an attacker who controls
  // (or guesses) one valid account could otherwise clear their IP-level
  // failure history and continue brute-forcing other accounts from the same
  // network. IP failures expire naturally with the window.
  if (email) loginEmailLimiter.reset(`email:${email}`);
}

export const __testing = { stores };
