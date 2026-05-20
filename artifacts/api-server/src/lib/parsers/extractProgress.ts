/**
 * Tiny in-process progress tracker for AI customer-file extracts (Task #296).
 *
 * The upload route accepts an opaque `progressKey` from the client
 * (a one-shot UUID minted in the browser) and threads it into
 * `aiExtractRows` via the options bag. The chunked extractor publishes
 * `{ current, total }` here after every chunk completes; the
 * frontend's `CustomerUploadPanel` polls
 * `GET /weeks/:weekStart/extract-progress/:key` once a second while
 * the upload is in flight and renders "Reading chunk N of M…" instead
 * of the previous frozen spinner.
 *
 * Single-process / single-instance: this is a `Map` in module scope,
 * not Redis. That's deliberate — the dispatcher's session is sticky
 * to one API instance via the proxy, the data only matters for the
 * ~90 seconds an extract is in flight, and going wider would add a
 * dependency for a feature whose worst-case fallback is a slightly
 * less informative spinner. Entries auto-expire after 10 minutes to
 * keep the map bounded.
 *
 * Task #369: this module also stores the **terminal** result of every
 * extract whose request was minted with a `progressKey`. The Replit
 * proxy caps proxied responses at 5 minutes (299999ms), and a real
 * AI customer-file extract on a big PDF/xlsx can run longer than
 * that. When the proxy cuts the socket, the in-flight POST rejects
 * on the client even though the server-side extractor keeps running
 * to completion (Node/Express handlers don't abort just because the
 * client went away). To recover, the route captures whatever it
 * eventually sends as `res.json(...)` into this module's result
 * store, and the existing `GET .../extract-progress/:key` endpoint
 * surfaces that result so the client can fetch it post-abort
 * (including across a browser reload via sessionStorage). Results
 * share the same 10-minute TTL as progress entries.
 */

interface ProgressEntry {
  current: number;
  total: number;
  /**
   * Task #328: when an upload resumes from staging, how many of `total`
   * chunks were already complete on a prior attempt and are being
   * skipped this run. 0 (or undefined) for a fresh upload. Surfaced
   * in the dispatcher's progress UI as "Resumed N of M — re-running K".
   */
  resumedFromStaging?: number;
  updatedAt: number;
}

/**
 * Task #369: stashed terminal response for an extract that was minted
 * with a progressKey. The route monkey-patches `res.json` to record
 * whatever it would have sent — success preview body, error envelope,
 * even validation 4xxs — so the client can retrieve it after the
 * proxy 5-minute cap killed the original POST. `httpStatus` mirrors
 * what `res.status(...)` was set to; defaults to 200.
 */
export interface ExtractResultEntry {
  httpStatus: number;
  body: unknown;
  updatedAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const _byKey = new Map<string, ProgressEntry>();
const _resultByKey = new Map<string, ExtractResultEntry>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of _byKey) {
    if (v.updatedAt < cutoff) _byKey.delete(k);
  }
  for (const [k, v] of _resultByKey) {
    if (v.updatedAt < cutoff) _resultByKey.delete(k);
  }
}

export function publishExtractProgress(
  key: string | undefined,
  current: number,
  total: number,
  resumedFromStaging?: number,
): void {
  if (!key) return;
  prune();
  _byKey.set(key, {
    current,
    total,
    resumedFromStaging,
    updatedAt: Date.now(),
  });
}

export function readExtractProgress(
  key: string,
): { current: number; total: number; resumedFromStaging?: number } | null {
  prune();
  const v = _byKey.get(key);
  if (!v) return null;
  const out: { current: number; total: number; resumedFromStaging?: number } = {
    current: v.current,
    total: v.total,
  };
  if (v.resumedFromStaging !== undefined) {
    out.resumedFromStaging = v.resumedFromStaging;
  }
  return out;
}

export function clearExtractProgress(key: string | undefined): void {
  if (!key) return;
  _byKey.delete(key);
  // Intentionally NOT clearing the result store here: the result must
  // outlive the progress entry so the client can pick it up after a
  // proxy-induced abort. TTL pruning above handles eventual cleanup.
}

/**
 * Task #369: stash the terminal response body the extract route would
 * have sent. Safe to call even when no progressKey was provided
 * (no-ops). The route monkey-patches `res.json` in terms of this
 * function so every code path — success, validation 4xx, internal
 * 500 — gets captured without rewriting the 700-line handler body.
 */
export function publishExtractResult(
  key: string | undefined,
  httpStatus: number,
  body: unknown,
): void {
  if (!key) return;
  prune();
  _resultByKey.set(key, {
    httpStatus,
    body,
    updatedAt: Date.now(),
  });
}

export function readExtractResult(key: string): ExtractResultEntry | null {
  prune();
  const v = _resultByKey.get(key);
  if (!v) return null;
  return { httpStatus: v.httpStatus, body: v.body, updatedAt: v.updatedAt };
}

/** @internal test seam — wipe all progress and result entries. */
export function __resetExtractProgressForTests(): void {
  _byKey.clear();
  _resultByKey.clear();
}
