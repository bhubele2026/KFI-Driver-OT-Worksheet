import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { TILES, TILE_GROUPS, TILE_KEYS, OWNER_ONLY_TILE_KEYS, isTileKey } from "../lib/tiles.js";
import { requireAuth, requireAdmin } from "../lib/auth.js";
import { requireOwner, type AuthedRequest } from "../lib/entraAuth.js";

export const tilesRouter: IRouter = Router();

/**
 * What this caller may see. The client renders the home grid and the section
 * nav from this — it never learns a tile it does not hold.
 */
tilesRouter.get("/tiles", (req: Request, res: Response) => {
  const a = req as AuthedRequest;
  // Deliberately NOT behind requireAuth. The client fails closed on an empty
  // tile list anyway, and answering instead of 401-ing lets the "no access"
  // screen say WHO you are signed in as — which is the difference between
  // "you have no tiles" and "identity resolution is broken". A bare 401 here
  // hid exactly that during the v86 rollout.
  if (!a.user) {
    res.json({
      tiles: [],
      gatedPaths: TILES.map((t) => t.href),
      isOwner: false,
      isAdmin: false,
      email: a.authEmail ?? null,
      signedIn: (a.authCandidates ?? []).length > 0,
    });
    return;
  }
  const held = a.tiles ?? [];
  const isAdmin = a.user?.isAdmin === true;
  res.json({
    signedIn: true,
    tiles: TILES.filter((t) => held.includes(t.key)).filter(
      // A tile marked adminOnly still needs the admin bit on top of the grant.
      (t) => !t.adminOnly || isAdmin,
    ),
    // Every tile path, held or not. The client needs this to distinguish "a
    // tile you don't hold" (bounce home) from "not a tile at all" (e.g. a
    // driver-detail URL, which must still resolve). Paths only — no titles.
    gatedPaths: TILES.map((t) => t.href),
    isOwner: a.isOwner === true,
    isAdmin,
    email: a.user?.email ?? a.authEmail ?? null,
  });
});

/** Usage log. A forged tile key never lands a row — it is checked against the caller's own grants. */
tilesRouter.post("/tile-open", requireAuth, (req: Request, res: Response) => {
  const a = req as AuthedRequest;
  const tile = String(req.body?.tile ?? "");
  const kind = String(req.body?.kind ?? "open");
  const detail = req.body?.detail == null ? null : String(req.body.detail).slice(0, 120);
  if ((a.tiles ?? []).includes(tile) && isTileKey(tile)) {
    void db
      .insert(schema.tileEventTable)
      .values({
        userId: a.user?.id ?? null,
        email: a.user?.email ?? null,
        tile,
        kind: kind === "login" ? "login" : "open",
        detail,
        source: "client",
      })
      .catch(() => {});
  }
  res.status(204).end();
});

// ── Owner: who can see what ───────────────────────────────────────────
// requireAdmin first so a non-admin gets the same 401/403 shape as the rest of
// the admin API; requireOwner then narrows it to Brad.

tilesRouter.get(
  "/admin/tile-access",
  requireAdmin,
  requireOwner,
  async (_req: Request, res: Response) => {
    const users = await db
      .select({
        id: schema.usersTable.id,
        email: schema.usersTable.email,
        isAdmin: schema.usersTable.isAdmin,
        isActive: schema.usersTable.isActive,
        role: schema.usersTable.role,
        lastLoginAt: schema.usersTable.lastLoginAt,
      })
      .from(schema.usersTable)
      .orderBy(sql`${schema.usersTable.isActive} desc, ${schema.usersTable.email}`);

    const grants = await db
      .select({
        userId: schema.userTileAccessTable.userId,
        tile: schema.userTileAccessTable.tile,
      })
      .from(schema.userTileAccessTable);

    const byUser = new Map<number, string[]>();
    for (const g of grants) {
      if (!byUser.has(g.userId)) byUser.set(g.userId, []);
      byUser.get(g.userId)!.push(g.tile);
    }

    res.json({
      registry: TILES.map((t) => ({
        key: t.key,
        group: t.group,
        title: t.title,
        ownerOnly: OWNER_ONLY_TILE_KEYS.includes(t.key),
        adminOnly: t.adminOnly === true,
      })),
      groups: TILE_GROUPS,
      users: users.map((u) => ({ ...u, tiles: byUser.get(u.id) ?? [] })),
    });
  },
);

/** Replace one person's grants. Owner-only tiles are dropped rather than rejected. */
tilesRouter.post(
  "/admin/user-tiles",
  requireAdmin,
  requireOwner,
  async (req: Request, res: Response) => {
    const a = req as AuthedRequest;
    const userId = Number(req.body?.userId);
    const incoming: unknown = req.body?.tiles;
    if (!Number.isInteger(userId) || !Array.isArray(incoming)) {
      res.status(400).json({ error: "userId and tiles[] are required" });
      return;
    }
    const tiles = [...new Set(incoming.map(String))].filter(
      (t) => TILE_KEYS.includes(t) && !OWNER_ONLY_TILE_KEYS.includes(t),
    );

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.userTileAccessTable)
        .where(sql`${schema.userTileAccessTable.userId} = ${userId}`);
      if (tiles.length) {
        await tx.insert(schema.userTileAccessTable).values(
          tiles.map((tile) => ({ userId, tile, grantedByUserId: a.user?.id ?? null })),
        );
      }
    });

    await db.insert(schema.userAuditLogTable).values({
      actorUserId: a.user?.id ?? null,
      targetUserId: userId,
      action: `set-tiles:${tiles.join("|") || "none"}`,
    });

    // Echo what actually persisted so the client reconciles from truth.
    res.json({ ok: true, userId, tiles });
  },
);

/** Activity: who has been opening what. */
tilesRouter.get(
  "/admin/tile-activity",
  requireAdmin,
  requireOwner,
  async (req: Request, res: Response) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
    const since = sql`now() - (${String(days)} || ' days')::interval`;

    const [byUser, byTile, recent] = await Promise.all([
      db.execute(sql`
        select e.email, count(*)::int as total, max(e.opened_at) as last_active
        from tile_event e
        where e.opened_at >= ${since} and e.kind = 'open'
        group by e.email order by total desc limit 50
      `),
      db.execute(sql`
        select e.tile, count(*)::int as total, count(distinct e.email)::int as users
        from tile_event e
        where e.opened_at >= ${since} and e.kind = 'open'
        group by e.tile order by total desc
      `),
      db.execute(sql`
        select e.email, e.tile, e.kind, e.detail, e.opened_at
        from tile_event e
        where e.opened_at >= ${since}
        order by e.opened_at desc limit 200
      `),
    ]);

    const rows = (r: unknown): unknown[] =>
      Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? []);

    res.json({
      days,
      byUser: rows(byUser),
      byTile: rows(byTile),
      recent: rows(recent),
    });
  },
);
