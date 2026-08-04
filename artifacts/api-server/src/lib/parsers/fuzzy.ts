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

/**
 * Structural quality of a name match, computed from the CANDIDATE's side.
 * `nameSimilarity` alone averages over the query's tokens, so a subset
 * query ("Juan", "Juan D.") scores a perfect 1.0 against "Juan Disla"
 * without the surname ever appearing on the document. Auto-assignment
 * must additionally require last-name agreement (Task: Burnett "both
 * Juans" / WB Erica Silverio Reyes, 2026-08-04):
 *  - `strongPairs`: distinct candidate tokens matched by some query token
 *    at ≥0.8 — ≥2 means first AND last name both agree.
 *  - `fullCoverage`: EVERY candidate token matched — the document name
 *    accounts for the driver's whole name (middle initials are already
 *    dropped by `normalize`). Partial coverage (e.g. "Reyes, Erica" vs
 *    "Erica Silverio Reyes") is picker material, not auto-assign.
 */
export interface NameMatchQuality {
  score: number;
  strongPairs: number;
  candidateTokens: number;
  fullCoverage: boolean;
}

const STRONG_TOKEN_FLOOR = 0.8;

export function nameMatchQuality(query: string, candidate: string): NameMatchQuality {
  const q = normalize(query);
  const c = normalize(candidate);
  if (q.length === 0 || c.length === 0) {
    return { score: 0, strongPairs: 0, candidateTokens: c.length, fullCoverage: false };
  }
  let strongPairs = 0;
  for (const ct of c) {
    let best = 0;
    for (const qt of q) {
      const s = tokenSimilarity(qt, ct);
      if (s > best) best = s;
    }
    if (best >= STRONG_TOKEN_FLOOR) strongPairs++;
  }
  return {
    score: nameSimilarity(query, candidate),
    strongPairs,
    candidateTokens: c.length,
    fullCoverage: strongPairs === c.length,
  };
}

/**
 * Gate for AUTO-assigning a driver from a document name with no badge or
 * saved alias: the match must be structurally sound — first and last name
 * both agree and the document name covers the driver's WHOLE roster name.
 * Extra document-side tokens (a second surname the roster doesn't carry,
 * e.g. "Lunar Molina, Aldo" → roster "Aldo Lunar") are fine and must not
 * block the match, so there is deliberately no average-score floor here —
 * the averaged score punishes exactly those extra tokens. Single-token
 * names ("Juan") and partial roster coverage ("Reyes, Erica" → roster
 * "Erica Silverio Reyes") can never silently claim a driver.
 */
export function isAutoAssignableName(query: string, candidate: string): boolean {
  const q = nameMatchQuality(query, candidate);
  return q.strongPairs >= 2 && q.fullCoverage;
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

/**
 * Resolve a customer-file row to a KFI driver id. This is the SINGLE
 * resolution policy shared by both extraction lanes so the deterministic
 * (cached-layout) reader matches drivers exactly as well as the AI path —
 * badge/alias → collision-guarded self-map → (optional AI hint) → saved
 * name alias → high-confidence fuzzy name. Returns null when nothing clears
 * the bar, so the row surfaces to the dispatcher instead of being silently
 * mis-attributed or dropped.
 *
 * Mirrors `imageSupport.resolveKfiId`; kept generic (no AI-row type) so the
 * deterministic reader can call it with just a badge + name. `aiPick` is
 * optional (the AI lane's `resolvedKfiId` hint) and simply skipped when absent.
 */
export function resolveDriverId(
  input: { badge: string; nameOnDoc: string; aiPick?: string | null },
  ctx: {
    idMap: Record<string, string>;
    fuzzyPool: ReadonlyArray<{ kfiId: string; name: string }>;
    kfiSet: ReadonlySet<string>;
    nameAliasMap?: ReadonlyMap<string, string>;
    uploadedCustomer: string;
    driversByKfi: ReadonlyMap<string, { name: string; customer: string | null }>;
  },
): string | null {
  const badge = (input.badge ?? "").trim();
  const nameOnDoc = (input.nameOnDoc ?? "").trim();
  if (badge) {
    // Explicit alias mapping is authoritative (case-insensitive to match the
    // driver_id_aliases lower(external_id) index); it wins outright.
    const mapped =
      ctx.idMap[badge] ??
      ctx.idMap[badge.toLowerCase()] ??
      ctx.idMap[badge.toUpperCase()];
    if (mapped && ctx.kfiSet.has(mapped)) return mapped;
    // Bare self-map (badge already equals a kfi_id) only when corroborated —
    // Task #363 collision guard (unrelated employee-number id spaces).
    const candidate = ctx.kfiSet.has(badge) ? badge : null;
    if (
      candidate &&
      isBadgeMatchTrustworthy({
        candidateKfiId: candidate,
        nameOnDoc,
        uploadedCustomer: ctx.uploadedCustomer,
        driversByKfi: ctx.driversByKfi,
        nameAliasMap: ctx.nameAliasMap,
      })
    ) {
      return candidate;
    }
  }
  const aiPick = (input.aiPick ?? "").trim();
  if (aiPick && ctx.kfiSet.has(aiPick) && ctx.fuzzyPool.some((d) => d.kfiId === aiPick)) {
    return aiPick;
  }
  if (!nameOnDoc) return null;
  // Saved per-customer name alias (a prior dispatcher decision) wins over fuzzy.
  if (ctx.nameAliasMap) {
    const aliased = ctx.nameAliasMap.get(nameOnDoc.toLowerCase());
    if (aliased && ctx.kfiSet.has(aliased)) return aliased;
  }
  const best = topMatches(
    nameOnDoc,
    ctx.fuzzyPool.map((d) => ({ kfiId: d.kfiId, name: d.name, customer: "" })),
    1,
  )[0];
  if (best && ctx.kfiSet.has(best.kfiId) && isAutoAssignableName(nameOnDoc, best.name)) {
    return best.kfiId;
  }
  return null;
}
