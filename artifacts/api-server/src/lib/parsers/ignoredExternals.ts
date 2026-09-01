/**
 * "Not a driver — never import" veto keys.
 *
 * `customer_ignored_externals` rows are keyed (lower(customer),
 * lower(external_id)), and the external id comes in two shapes — a real
 * badge/external id from the document, or the `name:<name-on-doc>` sentinel
 * the picker uses for rows that carried no id (see imageSupport.ts
 * unmapped-id construction). Both shapes are stored verbatim, so an ignore
 * rule can be badge-keyed, name-keyed, or (for the same human, saved at
 * different times) both.
 *
 * The veto is keyed on the DOC-side identity — the row's own badge and
 * name — deliberately independent of whichever lane (pinned badge alias,
 * name alias, fuzzy) would have resolved it. That is the lesson of the
 * Davis→Navarro incident: a saved mapping resolved an explicitly-ignored
 * worker onto the wrong driver because nothing ever consulted the ignore
 * list during matching.
 */

export const NAME_KEY_PREFIX = "name:";

/** Collapse inner whitespace + lower-case, matching the loader's keying. */
export function normalizeIgnoreKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The ignore keys a document row can match: its badge, its name sentinel. */
export function ignoreKeysForRow(
  badge?: string | null,
  nameOnDoc?: string | null,
): string[] {
  const keys: string[] = [];
  const b = (badge ?? "").trim();
  if (b) keys.push(normalizeIgnoreKey(b));
  const n = (nameOnDoc ?? "").trim();
  if (n) keys.push(NAME_KEY_PREFIX + normalizeIgnoreKey(n));
  return keys;
}

export function isIgnoredRow(
  set: ReadonlySet<string> | null | undefined,
  badge?: string | null,
  nameOnDoc?: string | null,
): boolean {
  if (!set || set.size === 0) return false;
  return ignoreKeysForRow(badge, nameOnDoc).some((k) => set.has(k));
}

/**
 * Keys to DELETE when a human explicitly maps this external id to a driver
 * in the picker — the newest human decision lifts the ignore. A badge pick
 * also clears the person's name-keyed rule (saved from an earlier week when
 * the row carried no id), or the pick would not stick on the next upload.
 */
export function ignoreClearKeysForPick(
  externalId: string,
  sampleName?: string | null,
): string[] {
  const keys: string[] = [normalizeIgnoreKey(externalId)];
  const n = (sampleName ?? "").trim();
  if (n) {
    const nameKey = NAME_KEY_PREFIX + normalizeIgnoreKey(n);
    if (nameKey !== keys[0]) keys.push(nameKey);
  }
  return keys;
}
