// CANONICAL @kfi/zenople v1.0.0 — sha256:d6c02a5e73fdcea763e8e2162dfc2d0123c0b8571e23bcfcd0e01abd735bb135
// VENDORED COPY — do not edit. Change KFI-Financial-Dashboard/packages/zenople/src/client.ts,
// then run `pnpm --filter @kfi/zenople sync`. Local edits fail this repo's green gate.
/**
 * The ONE Zenople client for the KFI fleet.
 *
 * Canonical copy: KFI-Financial-Dashboard/packages/zenople/src/client.ts.
 * Every other repo carries a VENDORED copy stamped with this file's hash — edit
 * here and re-run `scripts/sync-to.sh`, never edit a copy. Zero dependencies and
 * global `fetch` only, so the same bytes drop into any repo.
 *
 * ── Vendor limits (documented, and they bite) ───────────────────────────────
 *   • 20 TOKEN requests per hour  → one token, cached process-wide, single-flight.
 *   • 60 requests/min, 1000/hour  → a queue + sliding-window limiter in front of
 *     every call. We sit under both at 55/min and 900/hr.
 *   • An over-wide window does NOT error: HTTP 200 with a non-array body
 *     {"msg":"Large data set"}. That means "chunk it", never "no data".
 *   • Zenople added a SAME-PAYLOAD COOLDOWN: re-sending an identical body
 *     immediately is rejected as duplicate processing. `COOLDOWN_MS` below is
 *     our side of that contract and is NOT bypassable, not even with `force`.
 *
 * ── What this client guarantees its callers ────────────────────────────────
 *   queue + bounded concurrency · exponential backoff honoring Retry-After ·
 *   identical in-flight requests coalesced to one call · a same-payload cooldown ·
 *   optional TTL memo · per-request timeouts · sequential date chunking.
 *
 * Callers may keep their `Promise.all` — the queue is what bounds it.
 */

import { createHash } from "node:crypto";

export const ZENOPLE_CLIENT_VERSION = "1.0.0";

// ── Configuration ───────────────────────────────────────────────────────────

const envNum = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const cfg = () => ({
  base: (process.env["ZENOPLE_BASE_URL"] ?? "https://kfistaffingapi.zenople.com").replace(/\/+$/, ""),
  clientId: process.env["ZENOPLE_CLIENT_ID"] ?? "",
  clientSecret: process.env["ZENOPLE_CLIENT_SECRET"] ?? "",
});

const tokenUrl = () =>
  process.env["ZENOPLE_TOKEN_ENDPOINT"] ?? cfg().base + (process.env["ZENOPLE_TOKEN_PATH"] ?? "/connect/token");
const dataUrl = () =>
  process.env["ZENOPLE_DATA_ENDPOINT"] ?? cfg().base + (process.env["ZENOPLE_DATA_PATH"] ?? "/api/common/data");

const MAX_CONCURRENT = () => Math.max(1, envNum("ZENOPLE_MAX_CONCURRENT", 4));
const PER_MINUTE = () => Math.max(1, envNum("ZENOPLE_PER_MINUTE", 55));
const PER_HOUR = () => Math.max(1, envNum("ZENOPLE_PER_HOUR", 900));
/** Spread a burst instead of firing it. */
const MIN_GAP_MS = () => envNum("ZENOPLE_MIN_GAP_MS", 120);
const TIMEOUT_MS = () => Math.max(1000, envNum("ZENOPLE_TIMEOUT_MS", 120_000));
/** Our side of the vendor's same-payload cooldown. Never bypassable. */
const COOLDOWN_MS = () => envNum("ZENOPLE_COOLDOWN_MS", 10_000);
const MAX_RETRIES = () => envNum("ZENOPLE_MAX_RETRIES", 4);
const BACKOFF_BASE_MS = () => Math.max(1, envNum("ZENOPLE_BACKOFF_BASE_MS", 1000));
const MAX_BACKOFF_MS = () => Math.max(1000, envNum("ZENOPLE_MAX_BACKOFF_MS", 60_000));
const CACHE_MAX_ENTRIES = 200;

export const zenopleConfigured = (): boolean => {
  const c = cfg();
  return Boolean(c.clientId && c.clientSecret);
};

/** Tests replace `sleep` to assert the backoff ladder without waiting for it. */
export const __zenopleTestHooks = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
    }),
};
const sleep = (ms: number) => __zenopleTestHooks.sleep(ms);

// ── Errors ──────────────────────────────────────────────────────────────────

/** HTTP 200 + {"msg":"Large data set"} — narrow the window, do not treat as data. */
export class LargeDataSetError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(`Zenople ${action}: window too wide ("Large data set") — narrow or chunk it`);
    this.name = "LargeDataSetError";
    this.action = action;
  }
}

export class ZenopleHttpError extends Error {
  readonly action: string;
  readonly status: number;
  readonly body: string;
  constructor(action: string, status: number, body: string) {
    super(`Zenople ${action} ${status}: ${body.slice(0, 200)}`);
    this.name = "ZenopleHttpError";
    this.action = action;
    this.status = status;
    this.body = body;
  }
}

// ── Stats (fed to each app's /api/pulse) ────────────────────────────────────

const stats = {
  calls: 0,
  retries: 0,
  rateLimited: 0,
  cacheHits: 0,
  coalesced: 0,
  errors: 0,
  chunksSkipped: 0,
  lastError: null as string | null,
  lastErrorAt: null as string | null,
  lastSuccessAt: null as string | null,
};

export interface ZenopleStats {
  clientVersion: string;
  calls: number;
  retries: number;
  rateLimited: number;
  cacheHits: number;
  coalesced: number;
  errors: number;
  chunksSkipped: number;
  queueDepth: number;
  inFlight: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
}

export function zenopleStats(): ZenopleStats {
  return {
    clientVersion: ZENOPLE_CLIENT_VERSION,
    ...stats,
    queueDepth: waiters.length,
    inFlight: active,
  };
}

// ── Token: one per process, single-flight (20 token requests/hour) ──────────

let token: { value: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

async function accessToken(forceRefresh = false): Promise<string> {
  if (forceRefresh) token = null;
  if (token && Date.now() < token.expiresAt) return token.value;
  // Collapse concurrent callers onto ONE token request — five parallel feed
  // pulls must not spend five of the twenty hourly token requests.
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = (async () => {
    const c = cfg();
    if (!c.clientId || !c.clientSecret) throw new Error("Zenople credentials are not configured");
    const res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Zenople auth ${res.status}: ${text.slice(0, 200)}`.trim());
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Zenople auth returned no access_token");
    // Refresh a minute early so a token never expires mid-call.
    token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 7200) - 60) * 1000 };
    return token.value;
  })().finally(() => {
    tokenInFlight = null;
  });
  return tokenInFlight;
}

// ── The queue: FIFO, bounded concurrency, sliding-window rate limit ─────────

type Waiter = () => void;
const waiters: Waiter[] = [];
let active = 0;
let lastDispatchAt = 0;
const minuteWindow: number[] = [];
const hourWindow: number[] = [];
/** Set by a 429/503: every queued request waits, not just the one that was told to. */
let pausedUntil = 0;

let pumpTimer: ReturnType<typeof setTimeout> | null = null;
let pumpAt = Number.POSITIVE_INFINITY;

function prune(now: number): void {
  while (minuteWindow.length && now - minuteWindow[0]! > 60_000) minuteWindow.shift();
  while (hourWindow.length && now - hourWindow[0]! > 3_600_000) hourWindow.shift();
}

/** 0 = dispatch now, otherwise ms to wait before trying again. */
function waitFor(now: number): number {
  if (now < pausedUntil) return pausedUntil - now;
  prune(now);
  if (active >= MAX_CONCURRENT()) return 25;
  if (minuteWindow.length >= PER_MINUTE()) return Math.max(25, 60_000 - (now - minuteWindow[0]!));
  if (hourWindow.length >= PER_HOUR()) return Math.max(250, 3_600_000 - (now - hourWindow[0]!));
  const gap = MIN_GAP_MS() - (now - lastDispatchAt);
  return gap > 0 ? gap : 0;
}

/**
 * Hold the event loop open exactly while the queue has work.
 *
 * ⚠️ An unref'd timer does not keep Node alive. Unref this while requests are waiting — which is
 * every time the limiter pauses: the minute or hour window filling, a 429 hold, the same-payload
 * cooldown — and the pump becomes the only thing pending, so Node runs out of work and **exits
 * with code 0** while every queued request sits unsettled. The caller's `await` neither resolves
 * nor rejects; its job simply stops mid-run, having reported success.
 *
 * That is not hypothetical: it is why marts.fact_assignment sat unchanged from 2026-08-20 while
 * zenople-ops "succeeded" nightly. Its JobData windows pushed the limiter into a wait, the process
 * died there, and refresh.ts saw exit 0 and recorded the source as healthy.
 *
 * Idle stays unref'd, so a long-lived API process is never held open by this client.
 */
function setPumpRef(): void {
  if (!pumpTimer || typeof pumpTimer !== "object") return;
  const t = pumpTimer as unknown as { ref?: () => void; unref?: () => void };
  if (waiters.length === 0) t.unref?.();
  else t.ref?.();
}

function schedulePump(ms: number): void {
  const at = Date.now() + Math.max(0, ms);
  if (pumpTimer && at >= pumpAt) {
    setPumpRef(); // an earlier pump is booked — but it may have been booked while idle
    return;
  }
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpAt = at;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pumpAt = Number.POSITIVE_INFINITY;
    pump();
  }, Math.max(0, ms));
  setPumpRef();
}

function pump(): void {
  while (waiters.length) {
    const now = Date.now();
    const wait = waitFor(now);
    if (wait > 0) {
      schedulePump(wait);
      return;
    }
    const next = waiters.shift()!;
    active++;
    lastDispatchAt = now;
    minuteWindow.push(now);
    hourWindow.push(now);
    next();
  }
}

function acquire(): Promise<void> {
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
    schedulePump(0);
  });
}

function release(): void {
  active--;
  schedulePump(0);
}

// ── Retry policy ────────────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Retry-After in delta-seconds OR as an HTTP-date. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_BACKOFF_MS());
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_BACKOFF_MS());
  return null;
}

/** 1s → 2s → 4s → 8s, with jitter so parallel callers don't re-collide. */
function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS() * 2 ** attempt, MAX_BACKOFF_MS());
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

const isTransientNetworkError = (e: unknown): boolean => {
  if (e instanceof ZenopleHttpError || e instanceof LargeDataSetError) return false;
  const name = (e as { name?: string })?.name ?? "";
  const msg = String((e as { message?: string })?.message ?? e ?? "");
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)
  );
};

// ── Same-payload cooldown + TTL memo ────────────────────────────────────────

interface CacheEntry {
  at: number;
  rows: unknown[];
}
const cache = new Map<string, CacheEntry>();
const inFlightByKey = new Map<string, Promise<unknown[]>>();

function remember(key: string, rows: unknown[]): void {
  cache.set(key, { at: Date.now(), rows });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drop every memoised response. Does not clear the token or the rate windows. */
export function resetZenopleCache(): void {
  cache.clear();
}

/** Tests only: full reset of queue, token, cache and counters. */
export function __resetZenopleState(): void {
  cache.clear();
  inFlightByKey.clear();
  waiters.length = 0;
  minuteWindow.length = 0;
  hourWindow.length = 0;
  active = 0;
  lastDispatchAt = 0;
  pausedUntil = 0;
  token = null;
  tokenInFlight = null;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = null;
  pumpAt = Number.POSITIVE_INFINITY;
  Object.assign(stats, {
    calls: 0,
    retries: 0,
    rateLimited: 0,
    cacheHits: 0,
    coalesced: 0,
    errors: 0,
    chunksSkipped: 0,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
  });
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** Zenople's UTC format: `YYYY-MM-DD HH:mm:ss.fffffff`. Do not "fix" it. */
export const zTime = (d: Date | string | number): string =>
  new Date(d).toISOString().replace("T", " ").replace("Z", "0000");

const asDate = (d: Date | string | number): Date => (d instanceof Date ? d : new Date(d));

// ── pull() ──────────────────────────────────────────────────────────────────

export interface PullOptions {
  start?: Date | string | number;
  end?: Date | string | number;
  /** Convenience for `start = now - lookbackDays`, `end = now`. */
  lookbackDays?: number;
  /**
   * Default "Current". Pass `null` to OMIT the key entirely — PersonInterviewData
   * and AssignmentUserTypeData return 0 rows when includeData is present in ANY form.
   */
  includeData?: string | null;
  /** Merged into the request filters (after the date/includeData defaults). */
  filters?: Record<string, string>;
  /** Serve a response memoised within this many ms. The cooldown floor still applies. */
  cacheTtlMs?: number;
  /**
   * Skip the TTL memo — for a screen that is about to turn this data into a
   * QuickBooks entry. Does NOT skip the same-payload cooldown (the vendor
   * rejects an immediate identical body, so bypassing it would fail anyway).
   */
  force?: boolean;
  timeoutMs?: number;
}

function buildFilters(opts: PullOptions): Record<string, string> {
  const filters: Record<string, string> = {};
  let { start, end } = opts;
  if (opts.lookbackDays != null && start === undefined && end === undefined) {
    const now = Date.now();
    end = new Date(now);
    start = new Date(now - opts.lookbackDays * 86_400_000);
  }
  if (start !== undefined) filters["uTCStartDateTime"] = zTime(start);
  if (end !== undefined) filters["uTCEndDateTime"] = zTime(end);
  const include = opts.includeData === undefined ? "Current" : opts.includeData;
  if (include !== null) filters["includeData"] = include;
  return { ...filters, ...(opts.filters ?? {}) };
}

/**
 * One `/api/common/data` pull. Queued, rate-limited, retried with backoff,
 * coalesced and cooled down against identical payloads.
 */
export async function pull<T = Record<string, unknown>>(action: string, opts: PullOptions = {}): Promise<T[]> {
  const filters = buildFilters(opts);
  const body = JSON.stringify({ action, filters });
  const key = createHash("sha256").update(body).digest("hex");

  // An identical request already in flight: join it rather than send a second.
  const running = inFlightByKey.get(key);
  if (running) {
    stats.coalesced++;
    return (await running).slice() as T[];
  }

  // TTL memo, and beneath it the cooldown floor that `force` cannot bypass.
  const floor = Math.max(opts.force ? 0 : (opts.cacheTtlMs ?? 0), COOLDOWN_MS());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < floor) {
    stats.cacheHits++;
    return hit.rows.slice() as T[];
  }

  const task = (async (): Promise<unknown[]> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES(); attempt++) {
      // Assigned in the catch; the wait happens AFTER the slot is released, so a
      // backing-off request never occupies one of the concurrency slots.
      let retryWait: number | null = null;
      await acquire();
      try {
        const auth = await accessToken(attempt > 0 && lastError instanceof ZenopleHttpError && lastError.status === 401);
        stats.calls++;
        const res = await fetch(dataUrl(), {
          method: "POST",
          headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS()),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new ZenopleHttpError(action, res.status, text);
          if (res.status === 429 || res.status === 503) {
            stats.rateLimited++;
            // Hold the WHOLE queue, not just this request.
            const wait = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt);
            pausedUntil = Math.max(pausedUntil, Date.now() + wait);
          }
          throw err;
        }

        const json = (await res.json()) as unknown;
        if (!Array.isArray(json)) {
          const text = JSON.stringify(json);
          if (/large data set/i.test(text)) throw new LargeDataSetError(action);
          throw new Error(`Zenople ${action}: unexpected response ${text.slice(0, 200)}`);
        }

        stats.lastSuccessAt = new Date().toISOString();
        remember(key, json);
        return json;
      } catch (e) {
        lastError = e;
        // Never retry a wide window or a client mistake — only transient faults.
        const retryable =
          (e instanceof ZenopleHttpError && (RETRYABLE_STATUS.has(e.status) || e.status === 401)) ||
          isTransientNetworkError(e);
        if (!retryable || attempt >= MAX_RETRIES()) {
          stats.errors++;
          stats.lastError = e instanceof Error ? e.message : String(e);
          stats.lastErrorAt = new Date().toISOString();
          throw e;
        }
        stats.retries++;
        retryWait =
          e instanceof ZenopleHttpError && (e.status === 429 || e.status === 503)
            ? Math.max(0, pausedUntil - Date.now())
            : backoffMs(attempt);
      } finally {
        release();
      }
      if (retryWait != null) await sleep(retryWait);
    }
    throw lastError instanceof Error ? lastError : new Error(`Zenople ${action}: exhausted retries`);
  })();

  inFlightByKey.set(key, task);
  try {
    return (await task).slice() as T[];
  } finally {
    inFlightByKey.delete(key);
  }
}

// ── pullRange(): sequential date chunks, halving on "Large data set" ────────

export interface PullRangeOptions extends Omit<PullOptions, "start" | "end" | "lookbackDays"> {
  /** Days per chunk. Keep it small — the vendor asks for reasonable ranges. */
  chunkDays?: number;
  /** Pause between chunks, on top of the queue's own gap. */
  chunkGapMs?: number;
}

export interface PullRangeResult<T> {
  rows: T[];
  /**
   * Slices the API refused to serve at ANY width (an atomic cluster on one
   * timestamp — a bulk void batch, say). Recorded, never silently dropped:
   * a non-empty list means the pull is INCOMPLETE and the caller must say so.
   */
  skipped: string[];
}

/** Minimum span we will halve down to before recording a slice as unpullable. */
const HALVING_FLOOR_MS = 10_000;

async function pullHalving<T>(
  action: string,
  startISO: string,
  endISO: string,
  opts: PullRangeOptions,
  skipped: string[],
  depth: number,
): Promise<T[]> {
  try {
    return await pull<T>(action, { ...opts, start: startISO, end: endISO });
  } catch (e) {
    if (!(e instanceof LargeDataSetError)) throw e;
    const span = new Date(endISO).getTime() - new Date(startISO).getTime();
    if (span <= HALVING_FLOOR_MS) {
      skipped.push(`${startISO}..${endISO}`);
      stats.chunksSkipped++;
      return [];
    }
    // Back off before the narrower attempt rather than hammering the window down.
    await sleep(Math.min(BACKOFF_BASE_MS() * Math.min(depth + 1, 4), MAX_BACKOFF_MS()));
    const mid = new Date(new Date(startISO).getTime() + Math.floor(span / 2)).toISOString();
    const a = await pullHalving<T>(action, startISO, mid, opts, skipped, depth + 1);
    const b = await pullHalving<T>(action, mid, endISO, opts, skipped, depth + 1);
    return a.concat(b);
  }
}

/**
 * Walk [start, end) in sequential chunks. This is the ONLY sanctioned way to
 * pull more than a few weeks — it replaces every ad-hoc "try 365, then 180,
 * then 90…" ladder, which re-sent the same action back-to-back with no delay
 * and is exactly what the vendor's cooldown now blocks.
 */
export async function pullRange<T = Record<string, unknown>>(
  action: string,
  start: Date | string | number,
  end: Date | string | number,
  opts: PullRangeOptions = {},
): Promise<PullRangeResult<T>> {
  const chunkMs = Math.max(1, opts.chunkDays ?? 14) * 86_400_000;
  const endMs = asDate(end).getTime();
  const rows: T[] = [];
  const skipped: string[] = [];

  let cursor = asDate(start).getTime();
  let first = true;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    if (!first && opts.chunkGapMs) await sleep(opts.chunkGapMs);
    first = false;
    const part = await pullHalving<T>(
      action,
      new Date(cursor).toISOString(),
      new Date(chunkEnd).toISOString(),
      opts,
      skipped,
      0,
    );
    rows.push(...part);
    cursor = chunkEnd;
  }
  return { rows, skipped };
}

/** Dedupe helper — Zenople feeds duplicate per report template (~2×). */
export function dedupeBy<T>(rows: T[], key: (row: T) => string | number | null | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (k == null || k === "") {
      out.push(row);
      continue;
    }
    const s = String(k);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(row);
  }
  return out;
}
