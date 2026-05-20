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
