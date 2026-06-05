---
name: API server dev workflow is build-once, not watch
description: Why new API routes 404 in dev until the api-server workflow is restarted
---

The `artifacts/api-server: API Server` dev workflow runs `pnpm run build && pnpm run start`
(esbuild bundle → `node dist/index.mjs`). It is **not** a watch/HMR server — it builds
once at workflow start and serves that frozen bundle.

**Consequence:** any server-side change (new route, new mount, lib edit) is invisible until
you restart the workflow. The classic symptom is a brand-new endpoint returning **404**
(route literally absent from the running bundle) even though the code, codegen, and typecheck
are all correct. e2e specs that hit the new route fail at the DB-assertion / response step,
not at compile time.

**How to apply:** after adding/mounting an API route (or editing any `lib/*` the server
imports), `restart_workflow "artifacts/api-server: API Server"` before cur/e2e verification.
Confirm with `curl -s -o /dev/null -w "%{http_code}" localhost:80/api/<new-route>` — expect
401 (auth) / 400, not 404. (The Vite frontend workflow *does* hot-reload, so a stale browser
console error there is usually just an old HMR frame, not the current source.)
