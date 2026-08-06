# Security Audit — KFI Driver OT Worksheet

Hardening pass, **v67 (2026-08-05)**. Ports the stack built for the KFI Financial
Dashboard (see that repo's `docs/SECURITY-AUDIT.md`) onto this app, which had none of it.

## What's now in place

| Control | Detail |
| --- | --- |
| **Security headers** | `helmet()` with a real CSP. Unlike the Dashboard (which must disable CSP + frameguard because it's embedded as a Teams tab), this app is never framed, so `frame-ancestors 'none'` and the full CSP are on. |
| **`x-powered-by` off** | Was advertising `Express` on every response. |
| **CORS** | Was `origin: true, credentials: true` — it reflected back *whatever* origin asked and then allowed credentials on it, so any website could have driven this API with a visitor's session. Now an allowlist of `APP_BASE_URL` (plus localhost in dev). |
| **Compression** | `compression()` app-wide, SSE excluded. See "Performance" below. |
| **Non-root container** | Runtime stage runs as `USER node` with the tree `--chown`ed to it; adds a `HEALTHCHECK`. |
| **Error monitoring** | Sentry on both sides — `kfi-ot-api` and `kfi-ot-web` in org `kfi-staffing-llc`. Errors only (`tracesSampleRate: 0`), release = `APP_VERSION`. Init in `artifacts/api-server/src/instrument.ts` (must stay the FIRST import of `index.ts`) and `artifacts/kfi-ot/src/main.tsx`. Both no-op without a DSN, so local dev stays silent. |
| **CI** | `.github/workflows/ci.yml` — SPA build + server build, `pnpm audit --prod --audit-level high`, Semgrep (ERROR severity), gitleaks over full history. Advisory: no required checks on this plan. |

Already present before this pass and left alone: Postgres-backed rate limiting
(`lib/rateLimit.ts`), IP blocklist (`lib/ipBlocklist.ts`), `pino-http` request
logging, `trust proxy`, session auth (`lib/auth.ts`).

## Findings

### F1 — The app is public with authentication bypassed · **High · ACCEPTED BY OWNER**

`PUBLIC_BYPASS_AUTH=1` is set on the container and `VITE_PUBLIC_BYPASS_AUTH=1` is
baked into the bundle, so anyone who has the URL gets the full worksheet: driver
names, hours, overtime, pay rates and customer assignments. There is no login.

This is deliberate — the owner removed the login in order to share the app with the
team and reconfirmed that decision during this pass (2026-08-05). Recorded here so
the exposure is a documented choice rather than an oversight.

To close it later, either unset both env vars (restores per-user login) or add a
single shared access code.

### F2 — Zenople credentials stored as plain container env values · Medium

`ZENOPLE_CLIENT_ID` and `ZENOPLE_CLIENT_SECRET` are set as **literal values** on the
container app, not as secret references. Every other credential (`DATABASE_URL`,
`SESSION_SECRET`, `ANTHROPIC_API_KEY`, `CONNECTEAM_API_TOKEN`) correctly uses
`secretRef`. Anyone with Reader on the container app can read the Zenople secret from
the ARM resource.

Fix: move both to Container Apps secrets and switch the env entries to `secretRef`.
Requires `az containerapp secret set`, which the auto-mode guard blocks — the owner
has to name this change explicitly.

### F3 — CSP allows `'unsafe-inline'` for styles · Low

`style-src 'self' 'unsafe-inline'`. Tailwind/shadcn set inline styles for animation
delays and bar widths, and Radix injects them for popover positioning; a nonce-based
policy would mean threading a nonce through every one of those. Script-src has **no**
`unsafe-inline`, which is where XSS actually lands.

### F4 — Green gate is partial in CI · Low

`pnpm -r typecheck` is not yet wired into CI because it fails on **pre-existing**
errors unrelated to this pass (13 in `api-server`, plus stale generated
`@workspace/api-client-react` exports used by `admin-extract-staging.tsx`). Confirmed
identical before and after v67. CI runs the builds instead. Clear those errors, then
add the typecheck step.

### F5 — No automated tests in CI · Low (standing owner decision)

Test files exist under `__tests__` but are not run in CI and several no longer
compile against the current schema (missing `deactivated`).

## Performance (v67, same pass)

Not security, but found during the same audit and fixed alongside it:

- **No compression existed.** `/assets/index-*.js` was served at **1,470,725 bytes**
  with no `content-encoding`, even when the request offered `br, gzip` — Azure
  Container Apps' ingress does not compress for you. Adding `compression()` cuts the
  first load roughly 4×.
- **Static cache was 1 hour** despite Vite content-hashing every asset filename, so
  repeat visitors re-downloaded the whole bundle hourly. Now `/assets` is
  `immutable, max-age=1y` and `index.html` is `no-store`.
- **DB pool had no keepalive**, so bursts of queries re-handshaked TLS to Azure
  Postgres. Now `keepAlive: true` + `idleTimeoutMillis: 60_000`, matching the Dashboard.
- **react-query had no defaults** (`staleTime: 0`), so every click between drivers
  refetched everything. Now a 30s stale window, which is safe because ~33 modules call
  `invalidateQueries` and `use-live-updates.ts` fires 27 of them off the SSE stream.

Hosting was already correct and needed no change: app and `kfi-ot-pg` are both in
**East US 2**, in the same resource group and Container Apps environment.
