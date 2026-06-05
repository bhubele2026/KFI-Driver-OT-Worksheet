---
name: Worksheet Copilot agentic loop
description: Safety-rail invariants, loopback-reuse architecture, and test harness for the global Worksheet Copilot.
---

# Worksheet Copilot (agentic Claude assistant)

## Architecture: loopback reuse
Copilot tools never re-implement business logic. They call the app's own `/api`
routes via an authenticated in-process loopback fetch that forwards the
dispatcher's session cookie, so every existing guard (locked-week 409,
safeBulkDelete, audit rows, deletion snapshots, role checks, attribution)
is reused for free.
**Why:** duplicating mutation logic in the copilot would silently drift from the
real routes and bypass their guards.

## Safety-rail invariants (must hold; each has a regression test)
- **Read-before-write:** a mutation is refused until a *successful* read has run
  this turn. Set `hasRead` only when `!outcome.isError` — a failed/no-context
  read must NOT unlock mutations.
- **Gated action halts the whole turn:** when a destructive/over-threshold tool
  produces a `pendingAction`, every *remaining* `tool_use` block in the same
  Claude response must be skipped (emit a benign tool_result per skipped block so
  the one-result-per-tool_use API contract stays valid). Nothing may mutate
  behind an unconfirmed action. Only the explicit confirm endpoint replays calls.
**How to apply:** these live in `lib/copilot/{tools.ts,runCopilotTurn.ts}`; if you
touch the loop or the gating, re-run the copilot tests and keep both rails intact.

## OpenAPI ↔ route serialization must match exactly
The copilot route serializes DB-native shapes (`toolStep {tool,mutating,...}`,
`pendingAction {kind,title,summary[],calls[{method,path,label}]}`, message
`actionStatus`/`actionResult`, conversation `weekStart`/`kfiId`). send/confirm/cancel
return a `{message}` envelope (schema `CopilotMessageEnvelope`); cancel is
`POST .../cancel` (not DELETE on confirm). Edit `openapi.yaml` then run
`pnpm --filter @workspace/api-spec run codegen` and use the generated names verbatim.
**Why:** a drift here compiles fine but breaks the frontend hook at runtime (e.g. a
cancel hook hitting the wrong method/path).

## Test harness
Copilot tests use **`node:test` + `tsx`, NOT vitest**. Run from the
`artifacts/api-server` directory:
`node --import tsx --test 'src/lib/copilot/__tests__/*.test.ts'`.
Seams: `_copilotInternals.setClaudeClientOverride(client|null)` stubs Anthropic;
the loopback is injected as a `call` arg so no network/DB is needed.
