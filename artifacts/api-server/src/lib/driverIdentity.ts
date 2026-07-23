import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.js";

/**
 * ONE HUMAN, ONE ROW (2026-07-23).
 *
 * `drivers.kfiId` is the primary key, but it is DERIVED each sync from a
 * mutable Connecteam custom field with a fallback to the raw CT user id
 * (connecteam.ts fetchAllUsers). When that derivation changes — a blank
 * badge gets filled in, or a badge is edited — the kfiId-keyed upsert used
 * to INSERT A SECOND ROW for the same person, splitting their Connecteam
 * time and customer-sheet time across two records and breaking the
 * weekly-40 OT math and the Zenople export (verified live: Francisco
 * Cerda 2005894+18048531, Amado Tijerina 2005667+16747224).
 *
 * This module anchors identity on the STABLE key — `ct_user_id` — and runs
 * BEFORE the sync's driver upsert:
 *  - provisional row (kfiId == String(ctUserId)) + badge now derived
 *    → UPGRADE the row's kfiId in place (all dependents migrate).
 *  - provisional row AND badge row both exist (historic fork)
 *    → MERGE the provisional into the badge row, delete the provisional.
 *  - badge value changed in Connecteam → migrate the badge row to the new id.
 *  - derivation fell BACK to the ct id (badge cleared in CT) while a badge
 *    row exists → PIN the incoming user to the badge row instead; identity
 *    never downgrades and never forks.
 *
 * Dependent-row migration is GENERIC: every public table with a `kfi_id`
 * column is updated old→new inside one transaction; a unique-key conflict
 * on any table means the canonical row already has that slot, so the
 * source rows are dropped (canonical wins). Loud logs on every event.
 */

export interface IdentityLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface IdentityEvent {
  ctUserId: number;
  name: string;
  action: "upgrade" | "merge" | "badge-change" | "pin";
  from: string;
  to: string;
}

interface IncomingUser {
  ctUserId: number;
  kfiId: string;
  name: string;
}

/** Move every kfi_id-keyed row (all tables) from oldId to newId. */
export async function migrateKfiId(
  oldId: string,
  newId: string,
  log?: IdentityLog,
): Promise<void> {
  if (oldId === newId) return;
  await db.transaction(async (tx) => {
    const tables = await tx.execute<{ table_name: string }>(sql`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE column_name = 'kfi_id'
        AND table_schema = 'public'
        AND table_name <> 'drivers'
    `);
    for (const row of tables.rows) {
      const t = row.table_name;
      try {
        // Savepoint per table so a unique conflict doesn't poison the tx.
        await tx.transaction(async (sp) => {
          await sp.execute(
            sql`UPDATE ${sql.identifier(t)} SET kfi_id = ${newId} WHERE kfi_id = ${oldId}`,
          );
        });
      } catch (err) {
        // The canonical id already holds this slot (e.g. reviewed_drivers
        // PK, payroll profile) — canonical wins, source rows drop.
        await tx.execute(
          sql`DELETE FROM ${sql.identifier(t)} WHERE kfi_id = ${oldId}`,
        );
        log?.warn(
          { table: t, oldId, newId, err: String(err) },
          "identity migration: unique conflict — canonical row kept, source rows dropped",
        );
      }
    }
    const dest = await tx
      .select({ kfiId: schema.driversTable.kfiId })
      .from(schema.driversTable)
      .where(eq(schema.driversTable.kfiId, newId));
    if (dest.length > 0) {
      // Merge: destination driver row exists — the forked row dies.
      await tx
        .delete(schema.driversTable)
        .where(eq(schema.driversTable.kfiId, oldId));
    } else {
      await tx
        .update(schema.driversTable)
        .set({ kfiId: newId, updatedAt: new Date() })
        .where(eq(schema.driversTable.kfiId, oldId));
    }
  });
}

/**
 * Reconcile the incoming Connecteam roster against existing driver rows on
 * the ctUserId anchor. MUTATES `users` in place for the pin case so the
 * caller's upsert and ctUserId→kfiId punch map both use the canonical id.
 * Returns the events applied (empty on a quiet sync).
 */
export async function reconcileDriverIdentities(
  users: IncomingUser[],
  log?: IdentityLog,
): Promise<IdentityEvent[]> {
  const existing = await db
    .select({
      kfiId: schema.driversTable.kfiId,
      name: schema.driversTable.name,
      ctUserId: schema.driversTable.ctUserId,
    })
    .from(schema.driversTable);
  const byCt = new Map<number, Array<{ kfiId: string; name: string }>>();
  for (const r of existing) {
    if (r.ctUserId == null) continue;
    const arr = byCt.get(r.ctUserId) ?? [];
    arr.push({ kfiId: r.kfiId, name: r.name });
    byCt.set(r.ctUserId, arr);
  }

  const events: IdentityEvent[] = [];
  for (const u of users) {
    const rows = byCt.get(u.ctUserId) ?? [];
    if (rows.length === 0) continue; // brand-new human — plain insert
    const provisionalId = String(u.ctUserId);
    const provisional = rows.find((r) => r.kfiId === provisionalId);
    const badgeRows = rows.filter((r) => r.kfiId !== provisionalId);
    const derivedIsBadge = u.kfiId !== provisionalId;

    if (derivedIsBadge) {
      if (provisional && badgeRows.length === 0) {
        // Badge appeared for a provisional row → upgrade in place.
        await migrateKfiId(provisionalId, u.kfiId, log);
        events.push({
          ctUserId: u.ctUserId,
          name: u.name,
          action: "upgrade",
          from: provisionalId,
          to: u.kfiId,
        });
      } else if (provisional && badgeRows.length > 0) {
        // Historic fork: both rows exist. Merge provisional into the badge
        // row, then follow any badge-value change.
        const target = badgeRows[0].kfiId;
        await migrateKfiId(provisionalId, target, log);
        events.push({
          ctUserId: u.ctUserId,
          name: u.name,
          action: "merge",
          from: provisionalId,
          to: target,
        });
        if (target !== u.kfiId) {
          await migrateKfiId(target, u.kfiId, log);
          events.push({
            ctUserId: u.ctUserId,
            name: u.name,
            action: "badge-change",
            from: target,
            to: u.kfiId,
          });
        }
      } else if (badgeRows.length > 0 && badgeRows[0].kfiId !== u.kfiId) {
        // Badge value edited in Connecteam → follow it.
        await migrateKfiId(badgeRows[0].kfiId, u.kfiId, log);
        events.push({
          ctUserId: u.ctUserId,
          name: u.name,
          action: "badge-change",
          from: badgeRows[0].kfiId,
          to: u.kfiId,
        });
      }
      // else: badge row already matches the derivation — quiet.
    } else if (badgeRows.length > 0) {
      // Derivation fell back to the CT id (badge cleared in CT?) while a
      // badge row exists. Identity never downgrades: pin the incoming user
      // to the badge row so the upsert + punch map target the canonical id.
      u.kfiId = badgeRows[0].kfiId;
      events.push({
        ctUserId: u.ctUserId,
        name: u.name,
        action: "pin",
        from: provisionalId,
        to: u.kfiId,
      });
      if (provisional) {
        await migrateKfiId(provisionalId, badgeRows[0].kfiId, log);
        events.push({
          ctUserId: u.ctUserId,
          name: u.name,
          action: "merge",
          from: provisionalId,
          to: badgeRows[0].kfiId,
        });
      }
    }
  }

  // Observability: any surviving duplicate anchors or duplicate names are
  // worth a loud line — the next data surprise should not be invisible.
  const active = await db
    .select({
      kfiId: schema.driversTable.kfiId,
      name: schema.driversTable.name,
      ctUserId: schema.driversTable.ctUserId,
    })
    .from(schema.driversTable)
    .where(eq(schema.driversTable.deactivated, false));
  const ctSeen = new Map<number, string[]>();
  const nameSeen = new Map<string, string[]>();
  for (const r of active) {
    if (r.ctUserId != null) {
      const a = ctSeen.get(r.ctUserId) ?? [];
      a.push(r.kfiId);
      ctSeen.set(r.ctUserId, a);
    }
    const nk = r.name.trim().toLowerCase();
    const b = nameSeen.get(nk) ?? [];
    b.push(r.kfiId);
    nameSeen.set(nk, b);
  }
  const dupCt = [...ctSeen.entries()].filter(([, v]) => v.length > 1);
  const dupNames = [...nameSeen.entries()].filter(([, v]) => v.length > 1);
  if (dupCt.length > 0 || dupNames.length > 0) {
    log?.warn(
      {
        duplicateCtUserIds: dupCt.map(([ct, ids]) => ({ ct, ids })),
        duplicateNames: dupNames.map(([name, ids]) => ({ name, ids })),
      },
      "driver identity: duplicates still present after reconciliation",
    );
  }
  return events;
}
