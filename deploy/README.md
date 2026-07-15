# Deploy — Azure Container Apps

The Driver OT Worksheet runs as **one** Azure Container App: the container serves
both the built kfi-ot SPA and the `/api` backend (same origin). All state is in
Postgres; uploads are processed in memory. Access is the app's **built-in login**
(no Entra/EasyAuth).

## Prereqs
- `az` CLI logged in: `az login` (installed here at `~/.local/azure-cli-venv/bin/az`)
- Azure Postgres Flexible Server (16) reachable, with a database for this app
- Secrets to hand: `CONNECTEAM_API_TOKEN`, `ANTHROPIC_API_KEY` (both from the
  current Replit Secrets), a fresh `SESSION_SECRET` (`openssl rand -hex 32`), and
  the Azure `DATABASE_URL` (append `?sslmode=require`)

## One-time: schema
- **Fresh DB:** `DATABASE_URL=… pnpm --filter @workspace/db exec drizzle-kit push --force --config ./drizzle.config.ts`
  (run push directly on an empty DB — the `pre-migrate` step queries tables that
  don't exist yet).
- **Migrating Replit data:** run `deploy/migrate-db.sh` instead — the tables and
  `schema_fixup_markers` come from the dump. Then `check-drift` before any `push`.

## Deploy
```bash
export CONNECTEAM_API_TOKEN=…   # from Replit Secrets
export ANTHROPIC_API_KEY=…      # from Replit Secrets
export SESSION_SECRET=$(openssl rand -hex 32)
export DATABASE_URL='postgresql://…azure…?sslmode=require'
export RG=…  ACR=…  ENVIRONMENT=…   # discover with the NOTES in azure-deploy.sh
bash deploy/azure-deploy.sh v1
```
The script builds the image in ACR, creates/updates the Container App (external
ingress, target port 8080, **min=max=1 replica**), wires secrets as `secretref`
env vars, then sets `APP_BASE_URL` to the assigned FQDN.

### Why single replica
Postgres `LISTEN/NOTIFY` realtime + in-process interval jobs (digest, cleanups,
heartbeat) and the rate limiter assume one instance. Do not scale out without
refactoring those.

## Environment variables
| Var | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Azure PG | `?sslmode=require` |
| `SESSION_SECRET` | generated | cookie signing |
| `CONNECTEAM_API_TOKEN` | Replit Secrets | Connecteam REST |
| `ANTHROPIC_API_KEY` | Replit Secrets | Claude extraction/chat/copilot |
| `APP_BASE_URL` | set to FQDN | required in production |
| `NODE_ENV=production`, `PORT=8080` | fixed | |
| ~~`PUBLIC_BYPASS_AUTH`~~ | **do NOT set** | leaving it unset enforces login |
| Gemini (`AI_INTEGRATIONS_GEMINI_*`) | optional | Claude is default; omit to disable the Gemini fallback |

## Verify
- `https://<fqdn>/api/healthz` → `{"status":"ok"}`
- `https://<fqdn>/` → landing page; POST `/api/auth/dev-bypass` → **404** (backdoor closed)
- First visit: register the first user (becomes admin), then invite the rest.

## Retire Replit
Once Azure is verified, stop/delete the Replit deployment and the Render
`kfi-ct-proxy` if nothing else uses it. Update any bookmarks to the new FQDN.
