import { Router } from "express";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AcceptInviteBody,
  CreateInviteBody,
  LoginBody,
  RegisterBody,
  RequestPasswordResetBody,
  ResetPasswordBody,
  UpdateUserBody,
} from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import {
  generateToken,
  hashPassword,
  loadSessionUser,
  requireAdmin,
  verifyPassword,
} from "../lib/auth.js";
import { isMailerConfigured, sendMail } from "../lib/mailer.js";
import {
  checkLoginLimits,
  clearBucket,
  ipRateLimit,
  listActiveBuckets,
  recordLoginFailure,
  recordLoginSuccess,
} from "../lib/rateLimit.js";
import { pool } from "../lib/db.js";

export const authRouter = Router();

// Per-IP limits for unauthenticated, token/email-bearing endpoints.
const resetRequestLimiter = ipRateLimit({
  name: "auth:request-reset",
  windowMs: 60 * 60 * 1000,
  max: 10,
  message:
    "Too many password reset requests from your network. Please wait and try again.",
});
const tokenSubmitLimiter = ipRateLimit({
  name: "auth:token-submit",
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many attempts. Please wait and try again.",
});
const tokenLookupLimiter = ipRateLimit({
  name: "auth:token-lookup",
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Too many attempts. Please wait and try again.",
});

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const RESET_TTL_MS = 1000 * 60 * 60; // 1 hour

// After this many *consecutive* failed sign-ins for one account, the account
// is locked until an admin clears it or the user completes a password reset.
// This sits on top of the in-memory per-email rate limit (5/15min) so the lock
// persists across windows and IP rotations.
const ACCOUNT_LOCK_THRESHOLD = 10;

function publicUser(user: {
  id: number;
  email: string;
  createdAt: Date | string;
  isAdmin: boolean;
  isActive: boolean;
  failedLoginCount: number;
  lockedAt: Date | string | null;
  lastLoginAt?: Date | string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    isAdmin: user.isAdmin,
    isActive: user.isActive,
    failedLoginCount: user.failedLoginCount,
    lockedAt: user.lockedAt,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

// Build link origins from server config, never from request headers.
function appBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const replitDomains = process.env.REPLIT_DOMAINS;
  if (replitDomains) {
    const first = replitDomains.split(",")[0].trim();
    if (first) return `https://${first}`;
  }
  return null;
}

function requireAppBaseUrl(res: import("express").Response): string | null {
  const base = appBaseUrl();
  if (!base) {
    res
      .status(500)
      .json({ error: "Server is missing APP_BASE_URL; cannot build link." });
    return null;
  }
  return base;
}

type AuditAction =
  | "deactivate"
  | "reactivate"
  | "promote"
  | "demote"
  | "create-reset-link"
  | "create-invite"
  | "revoke-invite"
  | "accept-invite";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeAudit(
  tx: Tx | typeof db,
  entry: {
    actorUserId: number | null;
    targetUserId: number | null;
    targetEmail: string | null;
    action: AuditAction;
  },
): Promise<void> {
  await tx.insert(schema.userAuditLogTable).values(entry);
}

async function userCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.usersTable);
  return Number(row?.n ?? 0);
}

authRouter.get("/auth/registration-status", async (_req, res) => {
  const n = await userCount();
  res.json({ openRegistration: n === 0 });
});

authRouter.post("/auth/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const passwordHash = await hashPassword(parsed.data.password);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${schema.usersTable} IN EXCLUSIVE MODE`);
    const [row] = await tx.select({ n: count() }).from(schema.usersTable);
    if (Number(row?.n ?? 0) > 0) return { kind: "closed" as const };
    const [user] = await tx
      .insert(schema.usersTable)
      .values({ email, passwordHash, isAdmin: true, isActive: true })
      .returning();
    return { kind: "ok" as const, user };
  });
  if (result.kind === "closed") {
    res.status(403).json({ error: "Registration is invite-only. Ask an admin for an invite link." });
    return;
  }
  req.session.userId = result.user.id;
  req.log?.info({ userId: result.user.id }, "first user registered as admin");
  res.json(publicUser(result.user));
});

authRouter.post("/auth/login", async (req, res) => {
  if (!(await checkLoginLimits(req, res, null))) return;
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  if (!(await checkLoginLimits(req, res, email))) return;
  const user = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.email, email),
  });
  if (user && user.lockedAt) {
    recordLoginFailure(req, email);
    req.log?.warn({ userId: user.id }, "login attempt on locked account");
    res.status(423).json({
      error:
        "Account is locked due to repeated failed sign-ins. Reset your password or contact an admin.",
    });
    return;
  }
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    await recordLoginFailure(req, email);
    if (user) {
      const nextCount = user.failedLoginCount + 1;
      const shouldLock = nextCount >= ACCOUNT_LOCK_THRESHOLD;
      await db
        .update(schema.usersTable)
        .set({
          failedLoginCount: nextCount,
          ...(shouldLock ? { lockedAt: new Date() } : {}),
        })
        .where(eq(schema.usersTable.id, user.id));
      if (shouldLock) {
        req.log?.warn(
          { userId: user.id, failedLoginCount: nextCount },
          "account locked after repeated failed sign-ins",
        );
        res.status(423).json({
          error:
            "Account is locked due to repeated failed sign-ins. Reset your password or contact an admin.",
        });
        return;
      }
    }
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (!user.isActive) {
    await recordLoginFailure(req, email);
    res.status(401).json({ error: "Account is deactivated. Contact an admin." });
    return;
  }
  await recordLoginSuccess(req, email);
  const now = new Date();
  const [updated] = await db
    .update(schema.usersTable)
    .set({ lastLoginAt: now, failedLoginCount: 0, lockedAt: null })
    .where(eq(schema.usersTable.id, user.id))
    .returning();
  req.session.userId = user.id;
  res.json(publicUser(updated ?? { ...user, lastLoginAt: now, failedLoginCount: 0, lockedAt: null }));
});

authRouter.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("kfi.sid");
    res.status(204).end();
  });
});

authRouter.post("/auth/dev-bypass", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const email = "dev@kfi.local";
  let user = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.email, email),
  });
  if (!user) {
    const passwordHash = await hashPassword("dev-bypass-no-login");
    [user] = await db
      .insert(schema.usersTable)
      .values({ email, passwordHash, isAdmin: true, isActive: true })
      .returning();
  } else if (!user.isAdmin || !user.isActive) {
    [user] = await db
      .update(schema.usersTable)
      .set({ isAdmin: true, isActive: true })
      .where(eq(schema.usersTable.id, user.id))
      .returning();
  }
  req.session.userId = user.id;
  req.log?.info({ userId: user.id }, "dev auth bypass");
  res.json(publicUser(user));
});

authRouter.get("/auth/me", async (req, res) => {
  const user = await loadSessionUser(req);
  if (!user) {
    if (req.session?.userId) req.session.destroy(() => {});
    res.json(null);
    return;
  }
  res.json(publicUser(user));
});

// ----- Invites -----

authRouter.get("/auth/invites", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.invitesTable)
    .where(
      and(
        isNull(schema.invitesTable.usedAt),
        gt(schema.invitesTable.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.invitesTable.createdAt));
  res.json(rows);
});

authRouter.post("/auth/invites", requireAdmin, async (req, res) => {
  const parsed = CreateInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const existing = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.email, email),
  });
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }
  const base = requireAppBaseUrl(res);
  if (!base) return;
  const me = (req as { user?: { id: number } }).user!;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invite = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.invitesTable)
      .values({
        email,
        token,
        createdByUserId: me.id,
        expiresAt,
      })
      .returning();
    await writeAudit(tx, {
      actorUserId: me.id,
      targetUserId: null,
      targetEmail: email,
      action: "create-invite",
    });
    return created;
  });
  const acceptUrl = `${base}/accept-invite/${token}`;
  try {
    await sendMail({
      to: email,
      subject: "You're invited to KFI Dispatch",
      text:
        `You've been invited to KFI Dispatch.\n\n` +
        `Click the link below to set your password and sign in. The link expires in 7 days.\n\n` +
        `${acceptUrl}\n`,
    });
  } catch (err) {
    req.log?.error({ err }, "invite email send failed");
  }
  res.json({ ...invite, acceptUrl });
});

authRouter.post("/auth/invites/:token/resend", requireAdmin, async (req, res) => {
  if (!isMailerConfigured()) {
    res
      .status(503)
      .json({ error: "Email is not configured on the server. Copy the link instead." });
    return;
  }
  const token = String(req.params.token);
  const invite = await db.query.invitesTable.findFirst({
    where: eq(schema.invitesTable.token, token),
  });
  if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) {
    res.status(404).json({ error: "Invite not found, expired, or already used" });
    return;
  }
  const base = requireAppBaseUrl(res);
  if (!base) return;
  const acceptUrl = `${base}/accept-invite/${invite.token}`;
  try {
    const r = await sendMail({
      to: invite.email,
      subject: "You're invited to KFI Dispatch",
      text:
        `You've been invited to KFI Dispatch.\n\n` +
        `Click the link below to set your password and sign in. The link expires on ${invite.expiresAt.toISOString()}.\n\n` +
        `${acceptUrl}\n`,
    });
    res.json({ delivered: r.delivered });
  } catch (err) {
    req.log?.error({ err }, "invite resend email failed");
    res.status(502).json({ error: "Failed to send email." });
  }
});

authRouter.get("/auth/invites/:token", tokenLookupLimiter, async (req, res) => {
  const token = String(req.params.token);
  const invite = await db.query.invitesTable.findFirst({
    where: eq(schema.invitesTable.token, token),
  });
  if (!invite || invite.usedAt || invite.expiresAt.getTime() < Date.now()) {
    res.status(404).json({ error: "Invite not found, expired, or already used" });
    return;
  }
  res.json({ email: invite.email, expiresAt: invite.expiresAt });
});

authRouter.delete("/auth/invites/:token", requireAdmin, async (req, res) => {
  const token = String(req.params.token);
  const me = (req as { user?: { id: number } }).user!;
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(schema.invitesTable)
      .where(eq(schema.invitesTable.token, token))
      .returning();
    if (deleted) {
      await writeAudit(tx, {
        actorUserId: me.id,
        targetUserId: null,
        targetEmail: deleted.email,
        action: "revoke-invite",
      });
    }
  });
  res.status(204).end();
});

authRouter.post("/auth/accept-invite", tokenSubmitLimiter, async (req, res) => {
  const parsed = AcceptInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.password);
  const result = await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(schema.invitesTable)
      .where(eq(schema.invitesTable.token, parsed.data.token))
      .for("update")
      .limit(1);
    const invite = locked[0];
    if (
      !invite ||
      invite.usedAt !== null ||
      invite.expiresAt.getTime() <= Date.now()
    ) {
      return { kind: "invalid" as const };
    }
    const existing = await tx.query.usersTable.findFirst({
      where: eq(schema.usersTable.email, invite.email),
    });
    if (existing) return { kind: "duplicate" as const };
    await tx
      .update(schema.invitesTable)
      .set({ usedAt: new Date() })
      .where(eq(schema.invitesTable.id, invite.id));
    const [user] = await tx
      .insert(schema.usersTable)
      .values({
        email: invite.email,
        passwordHash,
        isAdmin: false,
        isActive: true,
      })
      .returning();
    await writeAudit(tx, {
      actorUserId: invite.createdByUserId,
      targetUserId: user.id,
      targetEmail: user.email,
      action: "accept-invite",
    });
    return { kind: "ok" as const, user };
  });
  if (result.kind === "invalid") {
    res.status(404).json({ error: "Invite not found, expired, or already used" });
    return;
  }
  if (result.kind === "duplicate") {
    res.status(409).json({ error: "Email already registered" });
    return;
  }
  req.session.userId = result.user.id;
  res.json(publicUser(result.user));
});

// ----- Password resets -----

authRouter.post("/auth/request-password-reset", resetRequestLimiter, async (req, res) => {
  const parsed = RequestPasswordResetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const user = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.email, email),
  });
  if (!user || !user.isActive) {
    res.json({ ok: true, resetUrl: null });
    return;
  }
  const base = appBaseUrl();
  if (!base) {
    req.log?.error(
      { userId: user.id },
      "password reset requested but APP_BASE_URL is not configured",
    );
    res.json({ ok: true, resetUrl: null });
    return;
  }
  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db.insert(schema.passwordResetsTable).values({
    userId: user.id,
    token,
    expiresAt,
  });
  const resetUrl = `${base}/reset-password/${token}`;
  req.log?.info({ userId: user.id }, "password reset requested");
  let delivered = false;
  try {
    const r = await sendMail({
      to: user.email,
      subject: "Reset your KFI Dispatch password",
      text:
        `A password reset was requested for your KFI Dispatch account.\n\n` +
        `Click the link below to choose a new password. The link expires in 1 hour.\n\n` +
        `${resetUrl}\n\n` +
        `If you didn't request this, you can ignore this email.\n`,
    });
    delivered = r.delivered;
  } catch (err) {
    req.log?.error({ err, userId: user.id }, "password reset email failed");
  }
  const echoLink = process.env.NODE_ENV !== "production" && !delivered;
  res.json({ ok: true, resetUrl: echoLink ? resetUrl : null });
});

authRouter.get("/auth/password-resets/:token", tokenLookupLimiter, async (req, res) => {
  const token = String(req.params.token);
  const reset = await db.query.passwordResetsTable.findFirst({
    where: eq(schema.passwordResetsTable.token, token),
  });
  if (!reset || reset.usedAt || reset.expiresAt.getTime() < Date.now()) {
    res.status(404).json({ error: "Token not found, expired, or already used" });
    return;
  }
  const user = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.id, reset.userId),
  });
  if (!user || !user.isActive) {
    res.status(404).json({ error: "Token not found, expired, or already used" });
    return;
  }
  res.json({ email: user.email, expiresAt: reset.expiresAt });
});

authRouter.post("/auth/reset-password", tokenSubmitLimiter, async (req, res) => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.password);
  const result = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.passwordResetsTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.passwordResetsTable.token, parsed.data.token),
          isNull(schema.passwordResetsTable.usedAt),
          gt(schema.passwordResetsTable.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!claimed) return { kind: "invalid" as const };
    const user = await tx.query.usersTable.findFirst({
      where: eq(schema.usersTable.id, claimed.userId),
    });
    if (!user || !user.isActive) return { kind: "invalid" as const };
    const [updated] = await tx
      .update(schema.usersTable)
      .set({ passwordHash, failedLoginCount: 0, lockedAt: null })
      .where(eq(schema.usersTable.id, user.id))
      .returning();
    await tx
      .update(schema.passwordResetsTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.passwordResetsTable.userId, user.id),
          isNull(schema.passwordResetsTable.usedAt),
        ),
      );
    return { kind: "ok" as const, user: updated };
  });
  if (result.kind === "invalid") {
    res.status(404).json({ error: "Token not found, expired, or already used" });
    return;
  }
  req.session.userId = result.user.id;
  res.json(publicUser(result.user));
});

authRouter.get("/auth/mailer-status", requireAdmin, (_req, res) => {
  res.json({ configured: isMailerConfigured() });
});

// ----- Rate-limit visibility -----

authRouter.get("/auth/rate-limit-buckets", requireAdmin, async (_req, res) => {
  const buckets = await listActiveBuckets(pool);
  res.json(
    buckets.map((b) => ({
      ...b,
      resetAt: new Date(b.resetAt).toISOString(),
    })),
  );
});

authRouter.delete(
  "/auth/rate-limit-buckets/:name/:key",
  requireAdmin,
  async (req, res) => {
    await clearBucket(String(req.params.name), String(req.params.key));
    req.log?.info(
      { name: req.params.name, key: req.params.key },
      "rate limit bucket cleared by admin",
    );
    res.status(204).end();
  },
);

// ----- Admin user management -----

authRouter.get("/auth/users", requireAdmin, async (_req, res) => {
  const users = await db
    .select()
    .from(schema.usersTable)
    .orderBy(desc(schema.usersTable.createdAt));
  res.json(users.map(publicUser));
});

authRouter.patch("/auth/users/:id", requireAdmin, async (req, res) => {
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Object.keys(req.body as Record<string, unknown>).length === 0
  ) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const target = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.id, id),
  });
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const me = (req as { user?: { id: number } }).user!;
  const patch: {
    isActive?: boolean;
    isAdmin?: boolean;
    lockedAt?: Date | null;
    failedLoginCount?: number;
  } = {};
  if (typeof parsed.data.isActive === "boolean") patch.isActive = parsed.data.isActive;
  if (typeof parsed.data.isAdmin === "boolean") patch.isAdmin = parsed.data.isAdmin;
  if (parsed.data.locked === false) {
    patch.lockedAt = null;
    patch.failedLoginCount = 0;
  } else if (parsed.data.locked === true) {
    res.status(400).json({
      error: "Admins can only clear lockouts (locked: false), not impose them.",
    });
    return;
  }
  // Reactivating an account also clears any prior lockout so the user can sign in again.
  if (patch.isActive === true && target.lockedAt) {
    patch.lockedAt = null;
    patch.failedLoginCount = 0;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No updatable fields provided (isActive, isAdmin, locked)." });
    return;
  }

  if (target.id === me.id && patch.isActive === false) {
    res.status(400).json({ error: "You cannot deactivate your own account." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const wouldRemoveAdminPower =
      target.isAdmin &&
      (patch.isAdmin === false || patch.isActive === false);
    if (wouldRemoveAdminPower) {
      await tx.execute(sql`LOCK TABLE ${schema.usersTable} IN EXCLUSIVE MODE`);
      const [{ n }] = await tx
        .select({ n: count() })
        .from(schema.usersTable)
        .where(
          and(
            eq(schema.usersTable.isAdmin, true),
            eq(schema.usersTable.isActive, true),
          ),
        );
      if (Number(n) <= 1) return { kind: "lastAdmin" as const };
    }
    const [updated] = await tx
      .update(schema.usersTable)
      .set(patch)
      .where(eq(schema.usersTable.id, id))
      .returning();
    const actions: AuditAction[] = [];
    if (typeof patch.isActive === "boolean" && patch.isActive !== target.isActive) {
      actions.push(patch.isActive ? "reactivate" : "deactivate");
    }
    if (typeof patch.isAdmin === "boolean" && patch.isAdmin !== target.isAdmin) {
      actions.push(patch.isAdmin ? "promote" : "demote");
    }
    for (const action of actions) {
      await writeAudit(tx, {
        actorUserId: me.id,
        targetUserId: target.id,
        targetEmail: target.email,
        action,
      });
    }
    return { kind: "ok" as const, user: updated };
  });
  if (result.kind === "lastAdmin") {
    res.status(400).json({ error: "At least one active admin must remain." });
    return;
  }
  res.json(publicUser(result.user));
});

authRouter.post("/auth/users/:id/password-reset", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const target = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.id, id),
  });
  if (!target || !target.isActive) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const base = requireAppBaseUrl(res);
  if (!base) return;
  const me = (req as { user?: { id: number } }).user!;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db.transaction(async (tx) => {
    await tx.insert(schema.passwordResetsTable).values({
      userId: target.id,
      token,
      expiresAt,
    });
    await writeAudit(tx, {
      actorUserId: me.id,
      targetUserId: target.id,
      targetEmail: target.email,
      action: "create-reset-link",
    });
  });
  res.json({ resetUrl: `${base}/reset-password/${token}`, expiresAt });
});

authRouter.post(
  "/auth/users/:id/send-password-reset",
  requireAdmin,
  async (req, res) => {
    if (!isMailerConfigured()) {
      res
        .status(503)
        .json({ error: "Email is not configured on the server. Generate a link instead." });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const target = await db.query.usersTable.findFirst({
      where: eq(schema.usersTable.id, id),
    });
    if (!target || !target.isActive) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const base = requireAppBaseUrl(res);
    if (!base) return;
    const me = (req as { user?: { id: number } }).user!;
    const token = generateToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await db.transaction(async (tx) => {
      await tx.insert(schema.passwordResetsTable).values({
        userId: target.id,
        token,
        expiresAt,
      });
      await writeAudit(tx, {
        actorUserId: me.id,
        targetUserId: target.id,
        targetEmail: target.email,
        action: "create-reset-link",
      });
    });
    const resetUrl = `${base}/reset-password/${token}`;
    try {
      const r = await sendMail({
        to: target.email,
        subject: "Reset your KFI Dispatch password",
        text:
          `An admin started a password reset for your KFI Dispatch account.\n\n` +
          `Click the link below to choose a new password. The link expires in 1 hour.\n\n` +
          `${resetUrl}\n`,
      });
      res.json({ delivered: r.delivered });
    } catch (err) {
      req.log?.error({ err, userId: target.id }, "admin password reset email failed");
      res.status(502).json({ error: "Failed to send email." });
    }
  },
);

authRouter.get("/auth/audit-log", requireAdmin, async (req, res) => {
  const limitParam = Number(req.query.limit);
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500
      ? limitParam
      : 100;
  const targetParam = Number(req.query.targetUserId);
  const filterTarget =
    Number.isInteger(targetParam) && targetParam > 0 ? targetParam : null;

  const actor = alias(schema.usersTable, "actor");
  const target = alias(schema.usersTable, "target");
  const where = filterTarget
    ? eq(schema.userAuditLogTable.targetUserId, filterTarget)
    : undefined;
  const baseQuery = db
    .select({
      id: schema.userAuditLogTable.id,
      action: schema.userAuditLogTable.action,
      createdAt: schema.userAuditLogTable.createdAt,
      actorUserId: schema.userAuditLogTable.actorUserId,
      actorEmail: actor.email,
      targetUserId: schema.userAuditLogTable.targetUserId,
      targetEmail: schema.userAuditLogTable.targetEmail,
    })
    .from(schema.userAuditLogTable)
    .leftJoin(actor, eq(actor.id, schema.userAuditLogTable.actorUserId))
    .leftJoin(target, eq(target.id, schema.userAuditLogTable.targetUserId));
  const rows = await (where ? baseQuery.where(where) : baseQuery)
    .orderBy(desc(schema.userAuditLogTable.createdAt))
    .limit(limit);
  res.json(rows);
});
