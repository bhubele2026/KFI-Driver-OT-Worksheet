# Auth & activity attribution

Summary of cookie/session auth, admin user management, lockout behavior, and the
audit trail.

## Auth model

- Cookie session, bcrypt passwords. Registration is invite-only after the first
  user.
- `/auth/registration-status` exposes whether the bootstrap account exists. The
  first registrant becomes admin (`isAdmin=true`); thereafter `/auth/register`
  returns 403.
- Admins (re)issue accounts via `/auth/invites` (single-use tokens, 7-day TTL).
  Acceptance happens at `/accept-invite/:token`.
- Self-serve password reset: `/auth/request-password-reset` always returns 200
  (no enumeration). When the SendGrid integration is connected the reset link
  is emailed; otherwise (dev only) the link is echoed in the response so local
  testing isn't blocked. Tokens are never logged in either case.
- Invite/reset URLs are built from `APP_BASE_URL` (or `REPLIT_DOMAINS[0]`) —
  never from `Host` / `X-Forwarded-*` headers — to defend against host-header
  poisoning.
- `requireAuth` re-loads the session user on every request and rejects if
  `isActive=false`.

## Admin users page

Admin-only `/auth/users` page (`/admin/users`) lists accounts and supports
deactivate / reactivate / promote / demote / generate-reset-link /
send-reset-email. Guards prevent self-deactivation and removing the last active
admin. Each row also shows `lastLoginAt` (stamped on `/auth/login`). The
invites list also has a per-row "Resend" action that re-emails the existing
accept link. Email-sending actions return 503 with a clear toast when the
SendGrid integration is not connected.

Admins see a dismissible "Email is not connected" banner on `/admin/users`
when SendGrid is not connected, driven by `GET /auth/mailer-status` (admin-only,
returns `{ configured: boolean }`).

## Account lockout

Persistent account lockout: after 10 consecutive failed sign-ins
(`failed_login_count` on `users`), `locked_at` is stamped and `/auth/login`
returns 423. A successful sign-in, a successful `/auth/reset-password`, or
admin reactivation/`PATCH /auth/users/:id { locked: false }` clears both
counter and lock. The admin users page shows the locked badge and an unlock
action. When the lock fires, the user is emailed (subject "Your KFI Dispatch
account was locked") with a fresh 1-hour password-reset link; silent no-op
when SendGrid isn't connected.

## Temporary public access (no login)

Auth is currently bypassed in the published build so the link can be shared
without sign-in. The published frontend auto-calls `POST /auth/dev-bypass` on
load, which finds-or-creates the shared `dev@kfi.local` admin user and signs
the visitor in as that user. Role checks (`requireAuth`, `requireAdmin`,
`requireSupervisorOrAdmin`) keep working — everyone is just the same admin.

Gated by two env vars, both set in the **production** environment:

- `PUBLIC_BYPASS_AUTH=1` — server-side, lets `/auth/dev-bypass` run when
  `NODE_ENV=production`. Without it the route 404s in prod (unchanged).
- `VITE_PUBLIC_BYPASS_AUTH=1` — frontend build-time flag that tells
  `AuthGate` in `artifacts/kfi-ot/src/App.tsx` to auto-call dev-bypass on load
  instead of redirecting to `/login`.

To restore the normal login flow, delete both env vars from the production
environment and redeploy. All login / invite / password-reset code is intact
and inert — nothing else needs to change.

Local dev is unaffected — `import.meta.env.DEV` already drives the same
auto-bypass behavior.

## Activity attribution

- `users.lastLoginAt` is stamped on every successful `/auth/login` and surfaced
  in the admin users table.
- `weeks.lastRefreshedBy` is stamped on every Connecteam refresh; the week
  summary returns `lastRefreshedByEmail` and the dashboard renders "by …" next
  to the timestamp.
- `punches.createdBy` (already stored on Connecteam refresh, customer-file
  upload, and manual creation) and `punches.updatedBy` (stamped on
  `PATCH /punches/:id`) drive per-row attribution. The week summary computes a
  per-driver "last touched by" from the most-recently-updated punch in that
  driver's week. The driver-detail view renders the actor email under each
  punch's badges.
- `DELETE /punches/:id` writes an append-only `punch_deletions` row
  (punchId, weekStart, kfiId, source, customer, deletedBy, deletedAt) inside
  the same transaction as the hard delete, so deletions are still attributable.
  The week summary folds the most recent delete per driver into the
  "last touched" calculation.
- Admin actions on user accounts are append-only logged to `user_audit_log`
  (actorUserId, targetUserId, targetEmail, action, createdAt) inside the same
  transaction as the change. Actions: `create-invite`, `revoke-invite`,
  `accept-invite`, `deactivate`, `reactivate`, `promote`, `demote`,
  `create-reset-link`. `GET /auth/audit-log?limit=&targetUserId=` (admin-only)
  returns recent entries joined to actor/target emails; the admin users page
  renders the last 50 in a "Recent activity" card.
