import bcrypt from "bcryptjs";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import { pool } from "./db.js";
import type { AuthedRequest, AppUser } from "./entraAuth.js";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export function buildSessionMiddleware(): RequestHandler {
  const PgStore = connectPgSimple(session);
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  return session({
    store: new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: false,
    }),
    name: "kfi.sid",
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  });
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * The signed-in user, or null.
 *
 * Identity now comes from Azure Easy Auth: `attachUserAndTiles` resolves the
 * caller's Entra claims to a `users` row once per request, above every router.
 * This function is the single seam that changed when password login was
 * retired — `requireAuth`, `requireAdmin` and `requireSupervisorOrAdmin`, and
 * all 65+ places they are mounted, are untouched.
 */
export async function loadSessionUser(req: Request): Promise<AppUser | null> {
  const user = (req as AuthedRequest).user;
  if (!user || !user.isActive) return null;
  return user;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const user = await loadSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  (req as Request & { user?: typeof user }).user = user;
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const user = await loadSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!user.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  (req as Request & { user?: typeof user }).user = user;
  next();
};

// Lock/unlock on a driver-week is a "supervisor" action; admins inherit it.
// Reviewers can mark drivers good/bad but cannot lock or unlock.
export const requireSupervisorOrAdmin: RequestHandler = async (req, res, next) => {
  const user = await loadSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!user.isAdmin && user.role !== "supervisor") {
    res.status(403).json({ error: "Supervisor or admin access required" });
    return;
  }
  (req as Request & { user?: typeof user }).user = user;
  next();
};
