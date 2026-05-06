#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Ensure the Playwright browser used by the kfi-ot e2e suite is available.
# On Replit the system Chromium is provided via $REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
# (and the matching system libs are pinned in replit.nix); elsewhere fall back
# to downloading it via Playwright so `pnpm test` works on a fresh machine.
pnpm run e2e:setup
