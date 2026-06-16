// Lightweight fuzzy matching used to suggest a Connecteam driver for a
// dispatcher-supplied driver name on an unknown customer document. Token-set
// based: order-insensitive, robust to "LAST, FIRST" vs "First Last" and
// extra middle initials.

// Below this name-similarity score, a badge → driver match is treated as a
// name collision and vetoed even when the customer lines up (see
// `isBadgeMatchTrustworthy`). 0.5 only trips on a strong disagreement, so a
// typo'd / OCR-garbled name (which still scores well above it) is unaffected.
const BADGE_NAME_VETO_FLOOR = 0.5;

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

/**
 * Task #363: guard against a numeric "employee number" on a customer
 * file accidentally colliding with a real KFI badge id. Trienda's
 * "Employee Number" column is an unrelated id space, but a Trienda row
 * for "Cortes, Natalia I" carried employee number `2003283` — which
 * happens to be the KFI badge of Felix Baez Caballero (a Burnett Dairy
 * driver who has never worked at Trienda). Without this check the row
 * silently imported as a Felix punch on top of his real shifts.
 *
 * A bare badge → kfi match is only "trustworthy" when at least ONE of
 * the following corroborating signals holds:
 *   - the matched KFI driver is actually on the uploaded customer's
 *     roster (drivers.customer matches the file's customer), OR
 *   - the dispatcher has previously saved a customer_name_aliases row
 *     pairing this exact (customer, nameOnDoc) with this candidate, OR
 *   - the row's nameOnDoc fuzzy-matches the candidate driver's name
 *     with high confidence (the same 0.85 threshold the AI extractor
 *     uses elsewhere).
 *
 * When none of those hold, callers must treat the badge as unresolved
 * and let the row fall through to the existing pending-named-rows /
 * unmappedIds path instead of silently misattributing the punches.
 *
 * The helper is intentionally tolerant of missing context (empty
 * nameOnDoc, missing alias map, candidate not in the driver map): in
 * any of those cases it still accepts the match IF the customer
 * happens to line up. The collision-protection only kicks in when the
 * row carries a recognizable name AND the driver belongs to a
 * different customer.
 */
export function isBadgeMatchTrustworthy(args: {
  candidateKfiId: string;
  nameOnDoc: string;
  uploadedCustomer: string;
  driversByKfi: ReadonlyMap<string, { name: string; customer: string | null }>;
  nameAliasMap?: ReadonlyMap<string, string> | null;
  similarityThreshold?: number;
}): boolean {
  const {
    candidateKfiId,
    nameOnDoc,
    uploadedCustomer,
    driversByKfi,
    nameAliasMap,
    similarityThreshold = 0.85,
  } = args;
  const driver = driversByKfi.get(candidateKfiId);
  // No driver record → can't compare customers/names. Be permissive
  // (callers already verified `kfiSet.has(candidate)`); the only way
  // to land here is a roster row that was excluded from the lookup
  // map, which is fine to accept.
  if (!driver) return true;
  const name = nameOnDoc.trim();
  // An explicit saved name alias pins this (customer, name) → candidate.
  // The dispatcher already vouched for it, so it wins over everything else.
  if (nameAliasMap && name) {
    const aliased = nameAliasMap.get(name.toLowerCase());
    if (aliased && aliased === candidateKfiId) return true;
  }
  // Strong name disagreement vetoes the badge match — even a same-customer
  // one. The customer file's "employee number" is an unrelated id space
  // (Task #363), so a colliding number must NOT steal a row whose name
  // clearly belongs to a different driver just because that driver happens
  // to sit on the uploaded customer's roster. Veto here and let the row fall
  // through to name-based resolution. This is the Penda "Choncoa, Ashley M"
  // case: her Penda emp# (2003274) collided with another Penda driver's KFI
  // id, so the same-customer rule pinned all her hours to the wrong person
  // and she imported as nothing. Only applies when the doc carries a usable
  // name; badge-only rows keep the customer-scoped behavior below.
  const nameScore = name ? nameSimilarity(name, driver.name) : null;
  if (nameScore !== null && nameScore < BADGE_NAME_VETO_FLOOR) {
    return false;
  }
  const uploadedLower = uploadedCustomer.trim().toLowerCase();
  const driverCustomerLower = (driver.customer ?? "").trim().toLowerCase();
  if (uploadedLower && driverCustomerLower === uploadedLower) return true;
  if (nameScore !== null && nameScore >= similarityThreshold) {
    return true;
  }
  return false;
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
