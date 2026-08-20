#!/usr/bin/env bash
# Green-gate guard for a VENDORED copy of the canonical Zenople client.
# Verifies the file body still hashes to the value stamped in its header, i.e.
# nobody hand-edited the copy instead of the canonical source.
set -euo pipefail
f="${1:?usage: check-zenople-client.sh <path-to-vendored-client>}"
[ -f "$f" ] || { echo "zenople client missing: $f" >&2; exit 1; }
want="$(sed -n '1s/.*sha256:\([0-9a-f]*\).*/\1/p' "$f")"
[ -n "$want" ] || { echo "$f has no CANONICAL stamp — re-vendor it" >&2; exit 1; }
got="$(tail -n +4 "$f" | shasum -a 256 | cut -d' ' -f1)"
[ "$want" = "$got" ] || {
  echo "$f was edited locally (body ${got:0:12}, stamp ${want:0:12})." >&2
  echo "Edit KFI-Financial-Dashboard/packages/zenople/src/client.ts and re-run the sync." >&2
  exit 1
}
echo "zenople client ok (canonical $(sed -n '1s/.*v\([0-9.]*\).*/\1/p' "$f"))"
