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
 */

interface ProgressEntry {
  current: number;
  total: number;
  updatedAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const _byKey = new Map<string, ProgressEntry>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of _byKey) {
    if (v.updatedAt < cutoff) _byKey.delete(k);
  }
}

export function publishExtractProgress(
  key: string | undefined,
  current: number,
  total: number,
): void {
  if (!key) return;
  prune();
  _byKey.set(key, { current, total, updatedAt: Date.now() });
}

export function readExtractProgress(
  key: string,
): { current: number; total: number } | null {
  prune();
  const v = _byKey.get(key);
  if (!v) return null;
  return { current: v.current, total: v.total };
}

export function clearExtractProgress(key: string | undefined): void {
  if (!key) return;
  _byKey.delete(key);
}

/** @internal test seam — wipe all progress entries. */
export function __resetExtractProgressForTests(): void {
  _byKey.clear();
}
