#!/usr/bin/env bash
# Migrate the live Replit Postgres data into Azure Postgres Flexible Server.
# All app state lives in Postgres (no object storage), so this is the whole
# data migration. Preserves schema_fixup_markers so destructive preMigrate
# fixups (e.g. the Sun->Sat cutover) do NOT re-fire against migrated data.
#
#   export SRC_URL='postgresql://...replit...'          # Replit DATABASE_URL
#   export DST_URL='postgresql://...azure...?sslmode=require'
#   bash deploy/migrate-db.sh
set -euo pipefail

: "${SRC_URL:?set SRC_URL = Replit DATABASE_URL}"
: "${DST_URL:?set DST_URL = Azure Postgres URL (?sslmode=require)}"

DUMP="${DUMP:-/tmp/kfi-ot-replit.dump}"

echo "== 1. Dump Replit DB (custom format, no owner/acl) =="
pg_dump "$SRC_URL" --format=custom --no-owner --no-acl --file "$DUMP"
echo "   wrote $DUMP ($(du -h "$DUMP" | cut -f1))"

echo "== 2. Restore into Azure DB =="
# --clean --if-exists makes the restore idempotent if re-run.
pg_restore --no-owner --no-acl --clean --if-exists --dbname "$DST_URL" "$DUMP"

echo "== 3. Sanity checks on Azure =="
psql "$DST_URL" -c "select count(*) as tables from information_schema.tables where table_schema='public';"
psql "$DST_URL" -c "select count(*) as users from users;" 2>/dev/null || true
psql "$DST_URL" -c "select count(*) as weeks from weeks;" 2>/dev/null || true
psql "$DST_URL" -c "select marker from schema_fixup_markers;" 2>/dev/null || \
  echo "   (schema_fixup_markers empty/absent — confirm before any 'db push')"

echo "== done. Next: run 'pnpm --filter @workspace/db run check-drift' against DST_URL"
echo "   to confirm the schema matches, then 'db push' ONLY if drift is reported."
