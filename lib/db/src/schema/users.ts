import { pgTable, serial, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  // 'reviewer' (default) or 'supervisor'. Orthogonal to isAdmin: an admin
  // can have either role. Supervisors (and admins) can lock/unlock a
  // driver-week to freeze it from further edits.
  role: text("role").notNull().default("reviewer"),
  isActive: boolean("is_active").notNull().default(true),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  // Last time an admin (or self-serve flow) sent this user a password-reset
  // email. Used by /auth/users/:id/send-password-reset as an atomic per-user
  // cooldown to stop duplicate sends from a double-clicked button.
  passwordResetLastSentAt: timestamp("password_reset_last_sent_at", {
    withTimezone: true,
  }),
  // Last time this admin viewed (or explicitly acknowledged) the hidden-notes
  // page. Used to compute the "recently hidden" badge count surfaced near the
  // Hidden notes link so admins notice when dispatchers' notes get hidden.
  notesHiddenLastSeenAt: timestamp("notes_hidden_last_seen_at", {
    withTimezone: true,
  }),
});

export type User = typeof usersTable.$inferSelect;

export const invitesTable = pgTable(
  "invites",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    token: text("token").notNull().unique(),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Last time we (re-)sent this invite by email. Drives a short server-side
    // cooldown so a double-clicked Resend doesn't spam the recipient.
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  },
  (t) => [index("idx_invites_email").on(t.email)],
);

export type Invite = typeof invitesTable.$inferSelect;

export const passwordResetsTable = pgTable(
  "password_resets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_password_resets_user").on(t.userId)],
);

export type PasswordReset = typeof passwordResetsTable.$inferSelect;

// Append-only audit of admin actions on user accounts (deactivate, reactivate,
// promote, demote, create-reset-link, create-invite, revoke-invite, accept-invite,
// delete-ai-extract-sample).
// actorUserId is nullable so we can record self-service actions like accept-invite
// where there is no admin actor. targetUserId is nullable + we keep targetEmail
// so invite-related events (which exist before any user row) stay attributable.
export const userAuditLogTable = pgTable(
  "user_audit_log",
  {
    id: serial("id").primaryKey(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    targetUserId: integer("target_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    targetEmail: text("target_email"),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_user_audit_log_target").on(t.targetUserId),
    index("idx_user_audit_log_created").on(t.createdAt),
  ],
);

export type UserAuditLog = typeof userAuditLogTable.$inferSelect;
