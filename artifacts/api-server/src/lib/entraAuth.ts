/**
 * Identity from Azure Easy Auth (Entra), replacing this app's password login.
 *
 * Easy Auth sits in front of the container and injects the caller's identity as
 * headers; the app never challenges. If Easy Auth is ever removed or
 * misconfigured, requests arrive with no identity and every guard fails closed.
 *
 * Ported from the KFI Financial Dashboard (apps/api/src/auth/entra.ts). The one
 * thing not to simplify: identity is collected from EVERY candidate header and
 * claim, not one. Everyone at KFI has two addresses — the UPN
 * (@krugerfamilyindustries.com) and the mail (@kfi.group) — and Easy Auth
 * sometimes reports a DISPLAY NAME in x-ms-client-principal-name. Matching on a
 * single header gives the same human two user rows and splits their history.
 */
import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db, schema } from "./db.js";
import { logger } from "./logger.js";
import { OWNER_ONLY_TILE_KEYS, TILE_KEYS } from "./tiles.js";

export type AppUser = typeof schema.usersTable.$inferSelect;

export interface AuthedRequest extends Request {
  authEmail?: string | null;
  authCandidates?: string[];
  authOid?: string | null;
  isOwner?: boolean;
  tiles?: string[];
  user?: AppUser;
}

const csvSet = (v: string | undefined): Set<string> =>
  new Set(
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

export const ownerEmails = (): Set<string> => csvSet(process.env.ADMIN_EMAILS);
const ownerOids = (): Set<string> => csvSet(process.env.ADMIN_OIDS);

// x-dev-email is honored ONLY outside production. The Dockerfile pins
// NODE_ENV=production, so a spoofed header can never mint identity in prod.
const devBypassAllowed = (): boolean => process.env.NODE_ENV !== "production";

export function callerIdentity(req: Request): {
  email: string | null;
  candidates: string[];
  oid: string | null;
  displayName: string | null;
} {
  const candidates = new Set<string>();
  let email: string | null = null;
  let displayName: string | null = null;
  let oid: string | null = req.header("x-ms-client-principal-id") ?? null;

  const dev = devBypassAllowed() ? req.header("x-dev-email") : undefined;
  if (dev) {
    email = dev.trim().toLowerCase();
    candidates.add(email);
  }

  const nameHeader = req.header("x-ms-client-principal-name");
  if (nameHeader) {
    const n = nameHeader.trim().toLowerCase();
    candidates.add(n);
    // Only treat it as the email if it looks like one — Easy Auth sometimes
    // puts the display name here.
    if (!email && n.includes("@")) email = n;
  }

  const principal = req.header("x-ms-client-principal");
  if (principal) {
    try {
      const decoded = JSON.parse(Buffer.from(principal, "base64").toString("utf8")) as {
        userId?: string;
        userDetails?: string;
        claims?: Array<{ typ: string; val: string }>;
      };
      if (!oid && decoded.userId) oid = decoded.userId;
      if (decoded.userDetails) candidates.add(decoded.userDetails.trim().toLowerCase());
      const claims = decoded.claims ?? [];
      const pick = (t: string) =>
        claims.find((c) => c.typ === t || c.typ.endsWith("/" + t))?.val;
      for (const t of ["preferred_username", "emailaddress", "upn", "email"]) {
        const v = pick(t);
        if (v) {
          const lv = v.trim().toLowerCase();
          candidates.add(lv);
          if (!email && lv.includes("@")) email = lv;
        }
      }
      const nameClaim = pick("name");
      if (nameClaim) displayName = nameClaim.trim();
    } catch {
      /* malformed principal — treated as no identity */
    }
  }
  return { email, candidates: [...candidates], oid, displayName };
}

/** True when the caller is the owner (ADMIN_EMAILS / ADMIN_OIDS). */
function computeIsOwner(candidates: string[], oid: string | null, req: Request): boolean {
  const emails = ownerEmails();
  const oids = ownerOids();
  return (
    process.env.DEV_OWNER === "true" ||
    (devBypassAllowed() && req.header("x-dev-owner") === "true") ||
    candidates.some((c) => emails.has(c)) ||
    (oid != null && oids.has(oid.toLowerCase()))
  );
}

/**
 * Resolve the Entra caller to this app's `users` row, creating it on first
 * sign-in. Matching is on ANY candidate address, so the two-domain problem
 * never forks a person into two rows.
 *
 * Returns null when there is no identity at all (Easy Auth absent) — callers
 * must treat that as unauthenticated.
 */
export async function resolveAppUser(req: Request): Promise<AppUser | null> {
  const a = req as AuthedRequest;
  const candidates = a.authCandidates ?? [];
  const emails = candidates.filter((c) => c.includes("@"));
  if (emails.length === 0) return null;

  const found = await db
    .select()
    .from(schema.usersTable)
    // ::text[] is required — Postgres cannot infer the element type of a bare
    // array bind, and the error it raises is easy to swallow.
    .where(sql`lower(${schema.usersTable.email}) = any(${emails}::text[])`)
    .limit(1);

  let user = found[0];

  if (!user) {
    const primary = (a.authEmail ?? emails[0]).toLowerCase();
    const inserted = await db
      .insert(schema.usersTable)
      .values({
        email: primary,
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        role: "reviewer",
      })
      .onConflictDoNothing({ target: schema.usersTable.email })
      .returning();
    user =
      inserted[0] ??
      (
        await db
          .select()
          .from(schema.usersTable)
          .where(sql`lower(${schema.usersTable.email}) = ${primary}`)
          .limit(1)
      )[0];
  }

  if (!user || !user.isActive) return null;

  // The owner is always an admin of their own app, regardless of the row.
  if (a.isOwner && !user.isAdmin) {
    const [bumped] = await db
      .update(schema.usersTable)
      .set({ isAdmin: true })
      .where(sql`${schema.usersTable.id} = ${user.id}`)
      .returning();
    if (bumped) user = bumped;
  }

  stampLastSeen(user.id);
  return user;
}

// Last-seen, throttled. This app is pinned to a single replica, so an in-process
// map is sufficient and keeps a write off every request.
const LAST_SEEN_MS = 5 * 60 * 1000;
const lastSeenAt = new Map<number, number>();
function stampLastSeen(userId: number): void {
  const now = Date.now();
  const prev = lastSeenAt.get(userId) ?? 0;
  if (now - prev < LAST_SEEN_MS) return;
  lastSeenAt.set(userId, now);
  void db
    .update(schema.usersTable)
    .set({ lastLoginAt: new Date() })
    .where(sql`${schema.usersTable.id} = ${userId}`)
    .catch(() => {});
}

/**
 * Global middleware: attach identity + the caller's tile set.
 * MUST be registered above every router — the Dashboard took a production
 * outage from registering the equivalent below them, where each route saw an
 * empty tile list.
 */
export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  const id = callerIdentity(req);
  const a = req as AuthedRequest;
  a.authEmail = id.email;
  a.authCandidates = id.candidates;
  a.authOid = id.oid;
  a.isOwner = computeIsOwner(id.candidates, id.oid, req);
  a.tiles = [];
  next();
}

/**
 * Resolve the caller to a user row + their tile set, once per request.
 *
 * Registered globally right after attachAuth and ABOVE every router, so
 * `req.user` / `req.tiles` are populated before any guard or route runs. The
 * Dashboard took a production outage from registering the equivalent below its
 * routers, where every route saw an empty tile list.
 *
 * No identity (Easy Auth absent, or a machine call on an excluded path) leaves
 * req.user undefined and the guards 401 — fail closed.
 */
export async function attachUserAndTiles(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const a = req as AuthedRequest;
  try {
    if ((a.authCandidates ?? []).some((c) => c.includes("@"))) {
      const user = await resolveAppUser(req);
      if (user) {
        a.user = user;
        a.tiles = await tilesForUser(user, a.isOwner === true);
      }
    }
  } catch (err) {
    // A DB blip must not hand out access: leave user/tiles unset. But it must
    // NOT be silent either — swallowing this made a broken identity lookup
    // look exactly like "not signed in".
    logger.error(
      { err, candidates: a.authCandidates, isOwner: a.isOwner },
      "identity resolution failed",
    );
  }
  next();
}

/** Owner-only guard, for the access panel and activity. */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!(req as AuthedRequest).isOwner) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  next();
}

/**
 * Tile set for a resolved user. The owner holds everything implicitly.
 * Everyone else — INCLUDING admins — holds exactly what they were granted:
 * admin means "may reach Settings and the admin API", not "sees every tile".
 */
export async function tilesForUser(user: AppUser, isOwner: boolean): Promise<string[]> {
  if (isOwner) return [...TILE_KEYS];
  const rows = await db
    .select({ tile: schema.userTileAccessTable.tile })
    .from(schema.userTileAccessTable)
    .where(sql`${schema.userTileAccessTable.userId} = ${user.id}`);
  return rows
    .map((r) => r.tile)
    .filter((t) => TILE_KEYS.includes(t) && !OWNER_ONLY_TILE_KEYS.includes(t));
}

/** Route guard: 403 unless the caller holds the tile. Hiding it in the UI is not security. */
export function requireTile(tile: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const a = req as AuthedRequest;
    if (!(a.tiles ?? []).includes(tile)) {
      res.status(403).json({ error: "forbidden", tile });
      return;
    }
    next();
  };
}
