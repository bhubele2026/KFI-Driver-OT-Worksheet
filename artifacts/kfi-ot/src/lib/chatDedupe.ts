import type { CustomerUploadChatMessage } from "@workspace/api-client-react";

/**
 * Task #428: idempotent merge for chat messages.
 *
 * The server persists the user turn immediately on `POST /chat` (before
 * Claude runs), so a concurrent refetch that lands while
 * `postMessage.isPending` will already contain the user message from
 * the DB. The drawer's `onMutate` also writes an optimistic copy with
 * a negative-id sentinel into the cache. Without merging, both would
 * render and the dispatcher would see their prompt twice.
 *
 * This function ONLY collapses an optimistic/server *pair* — i.e.
 * exactly one row in each duplicate set must have `id < 0` (optimistic
 * sentinel) and the matching one must have `id > 0` (persisted). Two
 * persisted rows with the same content are left alone — a dispatcher
 * legitimately sending the same prompt twice in a row, or the
 * assistant repeating itself, both render as separate messages.
 *
 * Pairing is nearest-timestamp within a 60s window, restricted to the
 * same `role` and `authorEmail` (so two different dispatchers typing
 * the same content don't collide).
 *
 * Pure / side-effect-free so it can be unit-tested under `node --test`.
 */
export function dedupeChatMessages(
  messages: CustomerUploadChatMessage[],
): CustomerUploadChatMessage[] {
  const optimisticIdxs: number[] = [];
  const persistedIdxs: number[] = [];
  messages.forEach((m, i) => {
    if (m.id < 0) optimisticIdxs.push(i);
    else persistedIdxs.push(i);
  });
  if (optimisticIdxs.length === 0) return messages.slice();

  // For each optimistic row, find the nearest persisted row within 60s
  // that has the same (role, content, authorEmail). Each persisted row
  // can only consume one optimistic row.
  const replaceWith = new Map<number, number>(); // optimisticIdx -> persistedIdx
  const claimed = new Set<number>();
  for (const oi of optimisticIdxs) {
    const opt = messages[oi];
    const optTs = Date.parse(opt.createdAt);
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (const pi of persistedIdxs) {
      if (claimed.has(pi)) continue;
      const p = messages[pi];
      if (p.role !== opt.role) continue;
      if (p.content !== opt.content) continue;
      if ((p.authorEmail ?? null) !== (opt.authorEmail ?? null)) continue;
      const delta = Math.abs(Date.parse(p.createdAt) - optTs);
      if (delta >= 60_000) continue;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = pi;
      }
    }
    if (bestIdx !== -1) {
      replaceWith.set(oi, bestIdx);
      claimed.add(bestIdx);
    }
  }

  if (replaceWith.size === 0) return messages.slice();

  // Build result: drop matched optimistic rows; keep persisted rows in
  // their original positions. Unmatched optimistic rows stay so the
  // dispatcher still sees their typed turn while the server round-trip
  // is in flight.
  const drop = new Set(replaceWith.keys());
  const result: CustomerUploadChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue;
    result.push(messages[i]);
  }
  return result;
}
