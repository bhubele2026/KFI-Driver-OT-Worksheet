# KFI Driver OT Worksheet — single-service image for Azure Container Apps.
# One container serves the built kfi-ot SPA AND the /api backend (same origin),
# replacing Replit's two-artifact router split.

# ---- builder ----------------------------------------------------------------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# pnpm via corepack, pinned to the version verified locally (newer pnpm treats
# ignored optional build scripts as a fatal error instead of a warning).
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate

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
# Temporary public sharing: build with --build-arg VITE_PUBLIC_BYPASS_AUTH=1
# (and set PUBLIC_BYPASS_AUTH=1 on the container) to skip the login screen.
ARG VITE_PUBLIC_BYPASS_AUTH=
ENV VITE_PUBLIC_BYPASS_AUTH=$VITE_PUBLIC_BYPASS_AUTH
# Version tag shown bottom-left of the home page; pass --build-arg APP_VERSION=vNN.
ARG APP_VERSION=
ENV VITE_APP_VERSION=$APP_VERSION
# Browser-side Sentry DSN, baked into the bundle at build time (DSNs are public
# by design). Omit it and the client-side Sentry init no-ops.
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
RUN pnpm --filter @workspace/kfi-ot build \
 && pnpm --filter @workspace/api-server build \
 && cp -r artifacts/kfi-ot/dist/public artifacts/api-server/dist/public

# Drop dev dependencies from the runtime dependency tree (keeps the externalized
# runtime deps like pdfkit/pdfjs-dist/pg that esbuild did not bundle).
RUN pnpm --filter @workspace/api-server prune --prod || true

# ---- runtime ----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# Runtime copy of the build tag so /api/app-version can report it.
ARG APP_VERSION=
ENV NODE_ENV=production \
    PORT=8080 \
    APP_VERSION=$APP_VERSION

# The app is stateless (uploads in-memory, all state in Postgres); copy the
# whole built workspace so pnpm's symlinked node_modules stay intact.
# Owned by the built-in `node` user so the runtime doesn't need root.
COPY --from=builder --chown=node:node /app /app

# Drop root. Nothing here writes outside /tmp and the port is 8080 (>1024), so
# there is no reason for the process to keep root privileges.
USER node

EXPOSE 8080
# Container Apps has its own probes, but this makes `docker run` locally and any
# non-ACA runtime surface a wedged process instead of a black box.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Deploy-time secrets (DATABASE_URL, SESSION_SECRET, APP_BASE_URL,
# ANTHROPIC_API_KEY, CONNECTEAM_API_TOKEN) are injected by Container Apps.
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
