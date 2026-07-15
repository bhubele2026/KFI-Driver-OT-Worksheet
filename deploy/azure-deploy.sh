#!/usr/bin/env bash
# Deploy KFI Driver OT Worksheet to Azure Container Apps (single service).
# Reuses existing KFI Azure infra. Access = the app's own built-in login
# (NO Entra / EasyAuth — per decision). Run after `az login`.
#
# Fill the CONFIG block (discover real names with the commands in NOTES), then:
#   bash deploy/azure-deploy.sh v1
set -euo pipefail

TAG="${1:?usage: azure-deploy.sh <image-tag e.g. v1>}"

# ── CONFIG (fill from your KFI Azure footprint) ──────────────────────────────
RG="${RG:-<kfi-resource-group>}"
ACR="${ACR:-<kfiRegistry>}"                 # name only, no .azurecr.io
ENVIRONMENT="${ENVIRONMENT:-<kfi-containerapps-env>}"
APP="${APP:-kfi-ot-worksheet}"
IMAGE="${ACR}.azurecr.io/${APP}:${TAG}"
TARGET_PORT=8080

# Secrets — export these in your shell before running (never commit them):
#   CONNECTEAM_API_TOKEN, ANTHROPIC_API_KEY, SESSION_SECRET, DATABASE_URL
: "${CONNECTEAM_API_TOKEN:?set CONNECTEAM_API_TOKEN}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
: "${SESSION_SECRET:?set SESSION_SECRET (openssl rand -hex 32)}"
: "${DATABASE_URL:?set DATABASE_URL (Azure PG, include ?sslmode=require)}"

# ── 1. Build the image in ACR (remote build from the repo Dockerfile) ────────
echo "== ACR build ${IMAGE} =="
az acr build --registry "$ACR" --image "${APP}:${TAG}" --file Dockerfile .

# ── 2. Create or update the Container App ────────────────────────────────────
if az containerapp show -g "$RG" -n "$APP" >/dev/null 2>&1; then
  echo "== update existing app =="
  az containerapp secret set -g "$RG" -n "$APP" --secrets \
    connecteam-token="$CONNECTEAM_API_TOKEN" \
    anthropic-key="$ANTHROPIC_API_KEY" \
    session-secret="$SESSION_SECRET" \
    database-url="$DATABASE_URL"
  az containerapp update -g "$RG" -n "$APP" --image "$IMAGE"
else
  echo "== create app =="
  az containerapp create -g "$RG" -n "$APP" \
    --environment "$ENVIRONMENT" \
    --image "$IMAGE" \
    --registry-server "${ACR}.azurecr.io" \
    --ingress external --target-port "$TARGET_PORT" \
    --min-replicas 1 --max-replicas 1 \
    --secrets \
      connecteam-token="$CONNECTEAM_API_TOKEN" \
      anthropic-key="$ANTHROPIC_API_KEY" \
      session-secret="$SESSION_SECRET" \
      database-url="$DATABASE_URL" \
    --env-vars \
      NODE_ENV=production \
      PORT="$TARGET_PORT" \
      CONNECTEAM_API_TOKEN=secretref:connecteam-token \
      ANTHROPIC_API_KEY=secretref:anthropic-key \
      SESSION_SECRET=secretref:session-secret \
      DATABASE_URL=secretref:database-url
fi

# ── 3. Set APP_BASE_URL to the assigned FQDN, then restart ───────────────────
FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo "== FQDN: https://${FQDN} =="
az containerapp update -g "$RG" -n "$APP" \
  --set-env-vars APP_BASE_URL="https://${FQDN}"

echo "== done. Health: https://${FQDN}/api/healthz =="
echo "NOTE: single min/max replica is intentional (Postgres LISTEN/NOTIFY +"
echo "in-process interval jobs assume one instance). Do NOT scale out without refactor."

# ── NOTES: discover real infra names ─────────────────────────────────────────
#   az group list -o table
#   az acr list -o table
#   az containerapp env list -o table
#   Postgres: az postgres flexible-server list -o table
