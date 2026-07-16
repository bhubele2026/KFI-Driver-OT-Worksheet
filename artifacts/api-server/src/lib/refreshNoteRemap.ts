/**
 * B3 — pure mapping helper for re-pointing row-level driver notes after a
 * Connecteam refresh replaces (delete + re-insert) a driver's punches.
 *
 * A refresh DELETEs then INSERTs Driver-source punches, so each returning
 * row gets a NEW primary-key id. A `driver_notes` row pinned to a deleted
 * punch's id would orphan even though the same shift came right back. This
 * computes `oldId → newId` for punches that represent the SAME shift,
 * matched on ctExternalKey first, then punch identity
 * (kfiId|date|clockIn|clockOut) for rows whose key is null.
 *
 * Pure (no DB): the route wraps a DB read/update around the returned map.
 */
export interface RefreshPunchRow {
  id: number;
  ctExternalKey: string | null;
  kfiId: string;
  date: string;
  clockIn: string;
  clockOut: string;
}

function identityOf(r: RefreshPunchRow): string {
  return `${r.kfiId}|${r.date}|${r.clockIn}|${r.clockOut}`;
}

/**
 * Build the `deletedPunchId → insertedPunchId` map for shifts that survived
 * the refresh. Entries where the shift did not come back, or mapped to the
 * same id, are omitted.
 */
export function computeNoteRemap(
  deletedRows: RefreshPunchRow[],
  insertedRows: RefreshPunchRow[],
): Map<number, number> {
  const oldIdToNew = new Map<number, number>();
  if (deletedRows.length === 0 || insertedRows.length === 0) return oldIdToNew;

  const newByKey = new Map<string, number>();
  const newByIdentity = new Map<string, number>();
  for (const r of insertedRows) {
    if (r.ctExternalKey) newByKey.set(r.ctExternalKey, r.id);
    // First writer wins for identity so two rows sharing an identity don't
    // ping-pong the mapping; ctExternalKey (unique per punch) is preferred
    // anyway and handled above.
    if (!newByIdentity.has(identityOf(r))) newByIdentity.set(identityOf(r), r.id);
  }
  for (const r of deletedRows) {
    const target =
      (r.ctExternalKey ? newByKey.get(r.ctExternalKey) : undefined) ??
      newByIdentity.get(identityOf(r));
    if (target != null && target !== r.id) oldIdToNew.set(r.id, target);
  }
  return oldIdToNew;
}
