// Lightweight fuzzy matching used to suggest a Connecteam driver for a
// dispatcher-supplied driver name on an unknown customer document. Token-set
// based: order-insensitive, robust to "LAST, FIRST" vs "First Last" and
// extra middle initials.

function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z\s,]/g, " ")
    .split(/[\s,]+/)
    .filter((t) => t.length > 1);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function tokenSimilarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Score in [0, 1]. Each token in `query` greedily matches the best token in
 * `candidate`; result is the average of those per-token similarities.
 */
export function nameSimilarity(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (q.length === 0 || c.length === 0) return 0;
  let total = 0;
  for (const qt of q) {
    let best = 0;
    for (const ct of c) {
      const s = tokenSimilarity(qt, ct);
      if (s > best) best = s;
    }
    total += best;
  }
  return total / q.length;
}

export interface DriverMatch {
  kfiId: string;
  name: string;
  customer: string;
  confidence: number;
}

export function topMatches(
  query: string,
  drivers: Array<{ kfiId: string; name: string; customer: string }>,
  limit = 5,
): DriverMatch[] {
  return drivers
    .map((d) => ({
      kfiId: d.kfiId,
      name: d.name,
      customer: d.customer,
      confidence: Math.round(nameSimilarity(query, d.name) * 1000) / 1000,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}
