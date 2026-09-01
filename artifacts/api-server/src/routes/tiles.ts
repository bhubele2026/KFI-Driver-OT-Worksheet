import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import {
  TILES, TILE_GROUPS, OWNER_ONLY_TILE_KEYS, isEventTileKey,
  GRANTABLE_KEYS, PAYROLL_GROUP_KEY, PAYROLL_TILE_KEYS,
} from "../lib/tiles.js";
import { requireAuth, requireAdmin } from "../lib/auth.js";
import { requireOwner, ownerEmails, noteClientEvent, type AuthedRequest } from "../lib/entraAuth.js";

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
      pathTiles: TILES.map((t) => ({ href: t.href, key: t.key })),
      // Report the REAL owner flag even with no user row — hardcoding false
      // here hid that the owner check was working and sent me after the wrong
      // bug entirely.
      isOwner: a.isOwner === true,
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
    // href → key for every tile, held or not: attribution for the click log.
    // Keys are opaque and the hrefs already travel above — nothing new leaks.
    pathTiles: TILES.map((t) => ({ href: t.href, key: t.key })),
    isOwner: a.isOwner === true,
    isAdmin,
    email: a.user?.email ?? a.authEmail ?? null,
  });
});

/** Client event kinds. `login` is deliberately absent — sign-in history is
 *  written server-side (entraAuth) and must never be mintable from a browser. */
const CLIENT_KINDS = new Set(["open", "click", "tab", "drill", "range"]);

/**
 * Usage log. Two shapes: one event (a board open / interaction) or a BATCH
 * (the click log, which would otherwise put a request on the wire per press).
 *
 * ⚠️ THE GRANT CHECK IS FOR OPENS ONLY. A board OPEN must be held to be
 * believed — a forged post could invent usage on a board nobody can reach. A
 * CLICK is different: it already happened, in a browser we served, and a
 * press on a surface someone doesn't hold is MORE worth seeing, not less.
 * (On Housing that guard silently produced ZERO click rows for the whole
 * team for a week — their landing presses carried a tile they don't hold.)
 */
tilesRouter.post("/tile-open", requireAuth, (req: Request, res: Response) => {
  const a = req as AuthedRequest;
  const incoming: unknown[] = Array.isArray(req.body?.events)
    ? (req.body.events as unknown[]).slice(0, 200)
    : [req.body];
  const rows: (typeof schema.tileEventTable.$inferInsert)[] = [];
  for (const raw of incoming) {
    const ev = raw as { tile?: unknown; kind?: unknown; detail?: unknown } | null;
    const tile = String(ev?.tile ?? "");
    const kindRaw = String(ev?.kind ?? "open");
    const kind = CLIENT_KINDS.has(kindRaw) ? kindRaw : "open";
    const detail = ev?.detail == null ? null : String(ev.detail).slice(0, 120);
    if (!isEventTileKey(tile)) continue;
    if (kind !== "click" && !(a.tiles ?? []).includes(tile) && tile !== "home" && tile !== "settings") continue;
    rows.push({
      userId: a.user?.id ?? null,
      email: a.user?.email ?? null,
      tile,
      kind,
      detail,
      source: "client",
    });
  }
  if (rows.length) {
    noteClientEvent(a.user?.email);
    void db.insert(schema.tileEventTable).values(rows).catch(() => {});
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

    const owners = ownerEmails();

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
      registry: [
        // The group grant leads its own group, the way the Dashboard puts
        // "Sales — all six salespeople" above the six.
        {
          key: PAYROLL_GROUP_KEY,
          group: "Payroll" as const,
          title: "Payroll — all twelve boards",
          blurb:
            "For whoever runs payroll. Covers every board in this group, including ones added later.",
          ownerOnly: false,
          adminOnly: false,
          isGroupGrant: true,
          covers: PAYROLL_TILE_KEYS,
        },
        ...TILES.map((t) => ({
          key: t.key,
          group: t.group,
          title: t.title,
          blurb: t.blurb,
          ownerOnly: OWNER_ONLY_TILE_KEYS.includes(t.key),
          adminOnly: t.adminOnly === true,
          isGroupGrant: false,
          covers: [] as string[],
        })),
      ],
      groups: TILE_GROUPS,
      // isOwner matters to the panel: the owner holds every tile implicitly and
      // so has NO grant rows. Without this flag Brad reads as "0 tiles", which
      // looks exactly like someone locked out of their own app.
      users: users.map((u) => ({
        ...u,
        tiles: byUser.get(u.id) ?? [],
        isOwner: owners.has(u.email.toLowerCase()),
      })),
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
    // GRANTABLE_KEYS, not TILE_KEYS: `payroll_all` is a group grant, not a tile.
    let tiles = [...new Set(incoming.map(String))].filter(
      (t) => GRANTABLE_KEYS.includes(t) && !OWNER_ONLY_TILE_KEYS.includes(t),
    );
    // Store the group grant instead of the twelve it confers, so a payroll tile
    // added later is covered without re-granting. Keeping both would leave
    // stale child rows behind when the group is later un-ticked.
    if (tiles.includes(PAYROLL_GROUP_KEY)) {
      tiles = tiles.filter((t) => !PAYROLL_TILE_KEYS.includes(t));
    }

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

/**
 * Activity: the owner's view of who has been where — every open, every click.
 * Mirrors the Financial Dashboard / KFI-Housing activity API:
 *  - `counted` dedupe: client rows are exact; a server-recorded row only
 *    counts when no client row from the same person sits within ±15 minutes
 *    (a stale cached bundle posts nothing, so the server writes a fallback).
 *  - `recent` has NO dedupe — a feed called "every click" must show the
 *    second press of the same button.
 *  - sign-ins come from durable login rows, seeded with users.last_login_at
 *    for the days before history existed. The owner is always included there.
 */
tilesRouter.get(
  "/admin/tile-activity",
  requireAdmin,
  requireOwner,
  async (req: Request, res: Response) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
    const includeOwner = req.query.includeOwner === "1";
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 400));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const ownersCsv = [...ownerEmails()].join(",");

    const rows = (r: unknown): unknown[] =>
      Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? []);

    try {
      const base = sql`
        with ev as (
          select lower(e.email) as email, e.tile, e.kind, e.detail, e.source, e.opened_at
          from tile_event e
          where e.opened_at >= now() - (${String(days)} || ' days')::interval
            and e.tile <> '_login'
            and e.email is not null
            and (${includeOwner}::boolean or not (lower(e.email) = any(string_to_array(${ownersCsv}, ','))))
        ),
        counted as (
          select ev.* from ev
          where ev.source = 'client'
             or not exists (
               select 1 from ev c
               where c.email = ev.email and c.source = 'client'
                 and c.opened_at between ev.opened_at - interval '15 minutes'
                                     and ev.opened_at + interval '15 minutes')
        )`;

      const [byTile, byUser, perUserTiles, recent, recentCount, signIns] = await Promise.all([
        db.execute(sql`${base}
          select tile,
                 count(*) filter (where kind = 'open')::int as count,
                 count(*) filter (where kind <> 'open')::int as interactions,
                 count(distinct email)::int as users
          from counted group by tile order by count desc`),
        db.execute(sql`${base}
          select email,
                 count(*) filter (where kind = 'open')::int as total,
                 count(*) filter (where kind <> 'open')::int as interactions,
                 to_char(max(opened_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "lastActive"
          from counted group by email order by max(opened_at) desc`),
        db.execute(sql`${base}
          select email, tile, count(*)::int as count
          from counted group by email, tile`),
        db.execute(sql`${base}
          select email, tile, kind, detail, source,
                 to_char(opened_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
          from counted order by opened_at desc limit ${limit} offset ${offset}`),
        db.execute(sql`${base} select count(*)::int as n from counted`),
        db.execute(sql`
          select s.email, to_char(s.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
          from (
            select lower(email) as email, opened_at as at from tile_event
            where kind = 'login' and email is not null
              and opened_at >= now() - (${String(days)} || ' days')::interval
            union all
            select lower(email), last_login_at from users
            where last_login_at is not null
              and last_login_at >= now() - (${String(days)} || ' days')::interval
          ) s group by s.email, s.at order by s.at desc limit 400`),
      ]);

      const tilesByUser = new Map<string, Array<{ tile: string; count: number }>>();
      for (const r of rows(perUserTiles) as Array<{ email: string; tile: string; count: number }>) {
        if (!tilesByUser.has(r.email)) tilesByUser.set(r.email, []);
        tilesByUser.get(r.email)!.push({ tile: r.tile, count: Number(r.count) });
      }
      const byUserRows = (rows(byUser) as Array<{ email: string; total: number; interactions: number; lastActive: string }>).map((u) => ({
        ...u,
        total: Number(u.total),
        interactions: Number(u.interactions),
        tiles: (tilesByUser.get(u.email) ?? []).sort((x, y) => y.count - x.count),
      }));

      res.json({
        days,
        totalOpens: byUserRows.reduce((n, u) => n + u.total, 0),
        totalInteractions: byUserRows.reduce((n, u) => n + u.interactions, 0),
        byUser: byUserRows,
        byTile: (rows(byTile) as Array<{ tile: string; count: number; interactions: number; users: number }>).map((t) => ({
          ...t, count: Number(t.count), interactions: Number(t.interactions), users: Number(t.users),
        })),
        recent: rows(recent),
        recentTotal: Number((rows(recentCount)[0] as { n?: number } | undefined)?.n ?? 0),
        recentOffset: offset,
        signIns: rows(signIns),
      });
    } catch {
      // A not-yet-migrated table must never 500 the panel.
      res.json({
        days, totalOpens: 0, totalInteractions: 0,
        byUser: [], byTile: [], recent: [], recentTotal: 0, recentOffset: 0, signIns: [],
      });
    }
  },
);
