/**
 * Republish safety net for the destructive pre-migrate fixups
 * (Task #402).
 *
 * `lib/db/src/preMigrate.ts` contains a handful of one-shot, marker-gated
 * fixups that issue `DELETE FROM punches ...` directly. They are dev-DB
 * tooling, but the task spec explicitly calls out the risk of a task merge
 * (or a confused operator) running `pnpm db push` against the production
 * database — at which point a marker-gated fixup that has never run there
 * would delete real punches.
 *
 * This guard is the structural fix:
 *
 *   - In production (`NODE_ENV=production`) it refuses to let any of the
 *     fixups in `DESTRUCTIVE_PUNCH_FIXUPS` execute unless
 *     `KFI_ALLOW_BULK_PUNCH_DELETE=1` is explicitly set for the process.
 *   - The decision is a pure function (`evaluatePreMigrateGuard`) so it
 *     can be unit-tested without spinning up Postgres.
 *   - When the live DB is reachable, the wrapping code in `preMigrate.ts`
 *     creates `data_mutation_audit` if it is missing and inserts a
 *     `refused` / `ok` / `noop` row keyed to `routine="preMigrate"` so
 *     every invocation — including a refused one — leaves a fingerprint
 *     on the same admin surface (`/admin/boot-audit`) as the boot-time
 *     routines.
 */
import type { Client } from "pg";

export const PRE_MIGRATE_OPT_IN_ENV = "KFI_ALLOW_BULK_PUNCH_DELETE";

/**
 * The fixup `name` values in `FIXUPS` that issue `DELETE FROM punches`
 * (directly or transitively via a DO block). Keep this list in sync
 * with `FIXUPS` in `lib/db/src/preMigrate.ts`. The pre-merge typecheck
 * does not enforce sync — a code review or follow-up grep is the
 * backstop. The unit test guards the list by name shape.
 */
export const DESTRUCTIVE_PUNCH_FIXUPS: readonly string[] = [
  "wipe legacy Mon-anchored and >2027 week rows (Sun→Sat cutover)",
  "purge e2e onboarding leakage (Task #359)",
];

export interface PreMigrateGuardEnv {
  nodeEnv: string | undefined;
  optIn: string | undefined;
}

export interface PreMigrateGuardDecision {
  outcome: "allow" | "refuse";
  reason: string;
}

export function evaluatePreMigrateGuard(
  env: PreMigrateGuardEnv,
  fixupNames: readonly string[],
): PreMigrateGuardDecision {
  const scheduled = fixupNames.filter((n) =>
    DESTRUCTIVE_PUNCH_FIXUPS.includes(n),
  );
  if (scheduled.length === 0) {
    return { outcome: "allow", reason: "no destructive fixups scheduled" };
  }
  if (env.nodeEnv !== "production") {
    return {
      outcome: "allow",
      reason: `non-production (NODE_ENV=${env.nodeEnv ?? "unset"})`,
    };
  }
  if (env.optIn === "1") {
    return {
      outcome: "allow",
      reason: `${PRE_MIGRATE_OPT_IN_ENV}=1 opt-in present in production`,
    };
  }
  return {
    outcome: "refuse",
    reason:
      `refusing destructive pre-migrate fixups in production: ` +
      `${scheduled.join(", ")}. Set ${PRE_MIGRATE_OPT_IN_ENV}=1 for ` +
      `this process to bypass.`,
  };
}

/**
 * Persist a pre-migrate outcome to `data_mutation_audit`. The audit
 * table is created on demand so this works on a brand-new DB. Best-
 * effort: any failure here is logged to stderr and swallowed — the
 * guard's refuse path still aborts the run via its caller throwing.
 */
export async function recordPreMigrateAudit(
  client: Client,
  outcome: "ok" | "noop" | "refused" | "error",
  detail: string,
  startedAt: Date,
): Promise<void> {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_mutation_audit (
        id serial PRIMARY KEY,
        routine text NOT NULL,
        outcome text NOT NULL,
        rows_affected integer NOT NULL DEFAULT 0,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz NOT NULL DEFAULT now(),
        deployment_id text,
        git_sha text,
        node_env text,
        detail text
      );
    `);
    await client.query(
      `INSERT INTO data_mutation_audit
         (routine, outcome, rows_affected, started_at, finished_at,
          deployment_id, git_sha, node_env, detail)
       VALUES ($1, $2, 0, $3, now(), $4, $5, $6, $7)`,
      [
        "preMigrate",
        outcome,
        startedAt,
        process.env.REPLIT_DEPLOYMENT_ID ?? null,
        process.env.REPLIT_GIT_COMMIT ??
          process.env.GIT_SHA ??
          process.env.SOURCE_COMMIT ??
          null,
        process.env.NODE_ENV ?? null,
        detail,
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[pre-migrate] failed to write data_mutation_audit row:", err);
  }
}
