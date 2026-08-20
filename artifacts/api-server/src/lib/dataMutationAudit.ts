import { db, schema } from "./db.js";
import { logger } from "./logger.js";

/**
 * Republish safety net (Task #402). One row per boot-time routine
 * invocation — including the zero-rows "no-op" case — so an operator
 * can confirm a clean republish at a glance and trace any actual
 * mutation back to the routine + deploy that produced it.
 *
 * Best-effort: the audit insert never throws back into the caller.
 * If the DB is unreachable we log and continue — the routines
 * themselves still ran (or were refused) regardless.
 */
export type BootAuditOutcome = "noop" | "ok" | "refused" | "error";

export interface RecordMutationInput {
  routine: string;
  outcome: BootAuditOutcome;
  rowsAffected: number;
  startedAt: Date;
  finishedAt?: Date;
  detail?: string;
}

/**
 * Identity of the running DEPLOY, not the running process. `APP_VERSION` is
 * what the Azure deploy stamps; REPLIT_DEPLOYMENT_ID is the Replit equivalent.
 * Null only in local dev, where re-running a boot routine is the point.
 */
export function deployKey(): string | null {
  const { deploymentId, gitSha } = envSnapshot();
  return deploymentId ?? gitSha ?? process.env.APP_VERSION ?? null;
}

function envSnapshot(): { deploymentId: string | null; gitSha: string | null; nodeEnv: string | null } {
  return {
    deploymentId: process.env.REPLIT_DEPLOYMENT_ID ?? null,
    gitSha:
      process.env.REPLIT_GIT_COMMIT ??
      process.env.GIT_SHA ??
      process.env.SOURCE_COMMIT ??
      null,
    nodeEnv: process.env.NODE_ENV ?? null,
  };
}

export async function recordMutation(input: RecordMutationInput): Promise<void> {
  const { deploymentId, gitSha, nodeEnv } = envSnapshot();
  try {
    await db.insert(schema.dataMutationAuditTable).values({
      routine: input.routine,
      outcome: input.outcome,
      rowsAffected: input.rowsAffected,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? new Date(),
      deploymentId,
      gitSha,
      nodeEnv,
      detail: input.detail ?? null,
    });
  } catch (err) {
    logger.warn(
      { err, routine: input.routine, outcome: input.outcome },
      "data_mutation_audit insert failed",
    );
  }
}

/**
 * Wrap a boot-time routine so its rows-affected count and outcome
 * always land in `data_mutation_audit`. The wrapped fn returns the
 * number of rows it actually wrote/deleted; on throw we record an
 * `error` row and re-throw so caller logging is unchanged.
 */
export async function withMutationAudit<T>(
  routine: string,
  fn: () => Promise<{ rowsAffected: number; detail?: string; result?: T }>,
): Promise<T | undefined> {
  const startedAt = new Date();
  try {
    const { rowsAffected, detail, result } = await fn();
    await recordMutation({
      routine,
      outcome: rowsAffected > 0 ? "ok" : "noop",
      rowsAffected,
      startedAt,
      detail,
    });
    return result;
  } catch (err) {
    await recordMutation({
      routine,
      outcome: "error",
      rowsAffected: 0,
      startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Has `routine` already run for the deploy we are currently on?
 *
 * Boot-time routines that call an external API must ask this BEFORE doing the
 * work — otherwise a crash-loop, a restart or a second replica re-runs them,
 * and each run costs real requests against a rate-limited vendor.
 *
 * Fails OPEN (returns false) when the audit table or the deploy identity is
 * unavailable: the routines here are all additive and idempotent, so running
 * one extra time is strictly better than silently skipping it forever.
 */
export async function hasRunThisDeploy(routine: string): Promise<boolean> {
  const key = deployKey();
  if (!key) return false; // local dev, or an un-stamped deploy
  try {
    const { and, eq, or } = await import("drizzle-orm");
    const t = schema.dataMutationAuditTable;
    const rows = await db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.routine, routine),
          or(eq(t.deploymentId, key), eq(t.gitSha, key)),
          or(eq(t.outcome, "ok"), eq(t.outcome, "noop")),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err, routine }, "hasRunThisDeploy check failed — allowing the routine to run");
    return false;
  }
}
