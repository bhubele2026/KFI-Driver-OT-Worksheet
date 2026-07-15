# KFI Driver OT Worksheet — single-service image for Azure Container Apps.
# One container serves the built kfi-ot SPA AND the /api backend (same origin),
# replacing Replit's two-artifact router split.

# ---- builder ----------------------------------------------------------------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# pnpm via corepack (version pinned by package.json "packageManager"/lockfile)
RUN corepack enable

# Install deps first (better layer caching). node_modules is .dockerignore'd so
# this is a clean linux install — pnpm fetches the correct linux native binaries
# for esbuild/rollup/lightningcss/tailwind-oxide (the platform-exclusion
# overrides were removed as part of the de-Replit migration).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY artifacts/kfi-ot/package.json artifacts/kfi-ot/package.json
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/api-client-react/package.json lib/api-client-react/package.json
COPY scripts/package.json scripts/package.json
RUN pnpm install --frozen-lockfile

# Build both apps, then place the SPA next to the built server so app.ts serves
# it from `./public` (resolved relative to dist/index.mjs).
COPY . .
ENV BASE_PATH=/
RUN pnpm --filter @workspace/kfi-ot build \
 && pnpm --filter @workspace/api-server build \
 && cp -r artifacts/kfi-ot/dist/public artifacts/api-server/dist/public

# Drop dev dependencies from the runtime dependency tree (keeps the externalized
# runtime deps like pdfkit/pdfjs-dist/pg that esbuild did not bundle).
RUN pnpm --filter @workspace/api-server prune --prod || true

# ---- runtime ----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

# The app is stateless (uploads in-memory, all state in Postgres); copy the
# whole built workspace so pnpm's symlinked node_modules stay intact.
COPY --from=builder /app /app

EXPOSE 8080
# Deploy-time secrets (DATABASE_URL, SESSION_SECRET, APP_BASE_URL,
# ANTHROPIC_API_KEY, CONNECTEAM_API_TOKEN) are injected by Container Apps.
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
