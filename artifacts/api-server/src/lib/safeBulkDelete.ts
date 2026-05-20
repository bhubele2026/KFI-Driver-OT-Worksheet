import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db, schema } from "./db.js";
import { logger } from "./logger.js";
import { recordMutation } from "./dataMutationAudit.js";

/**
 * Default threshold for runtime / route-handler bulk punch deletes
 * (Task #402). Dispatcher-driven operations like "Remove Connecteam
 * time for a driver-week" or "Reset week" can legitimately delete
 * dozens of rows; the threshold here is high enough that normal
 * dispatcher flows are never refused, but low enough that a runaway
 * code path trying to wipe the whole table cannot do so silently in
 * production without `KFI_ALLOW_BULK_PUNCH_DELETE=1`. Boot-time
 * mutators use the much lower DEFAULT_BULK_DELETE_THRESHOLD (5) so a
 * silent boot rewrite of more than a handful of rows trips the guard.
 */
export const RUNTIME_PUNCH_DELETE_THRESHOLD = 500;

/**
 * Production fail-safe (Task #402). Any code path that may delete more
 * than `threshold` rows from a dispatcher-visible table in a single
 * statement must route through this helper. In production we count
 * the matching rows first; if the would-be delete exceeds the threshold
 * we **refuse** unless the caller has explicitly opted in for this
 * process via `KFI_ALLOW_BULK_PUNCH_DELETE=1`. Every outcome — allowed,
 * refused, or empty match — is written to `data_mutation_audit` so the
 * next "the time disappeared" incident is either traceable to the row
 * that did it, or provably caused by something other than this helper.
 *
 * Non-production environments (`NODE_ENV !== "production"`) and the
 * pre-merge e2e suite are unaffected — the guard only enforces the
 * threshold + opt-in in production. We still audit every call so the
 * dev DB is a faithful preview of the prod audit table.
 */
export const DEFAULT_BULK_DELETE_THRESHOLD = 5;
export const BULK_DELETE_OPT_IN_ENV = "KFI_ALLOW_BULK_PUNCH_DELETE";

export class BulkDeleteRefusedError extends Error {
  constructor(
    public readonly routine: string,
    public readonly tableLabel: string,
    public readonly matched: number,
    public readonly threshold: number,
  ) {
    super(
      `Refusing bulk delete in production: routine="${routine}" table="${tableLabel}" matched=${matched} threshold=${threshold}. Set ${BULK_DELETE_OPT_IN_ENV}=1 for this process to bypass.`,
    );
    this.name = "BulkDeleteRefusedError";
  }
}

export interface SafeBulkDeleteOptions<TTable extends PgTable> {
  /** Human-readable routine name for the audit row + logs. */
  routine: string;
  /** Human-readable table name for the audit row + logs. */
  tableLabel: string;
  /** Drizzle table to delete from. */
  table: TTable;
  /** Drizzle WHERE clause (AND of all predicates). */
  where: SQL;
  /** Override the default 5-row guard threshold for this call. */
  threshold?: number;
}

export interface SafeBulkDeleteResult {
  outcome: "ok" | "noop" | "refused";
  matched: number;
  deleted: number;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isOptedIn(): boolean {
  return process.env[BULK_DELETE_OPT_IN_ENV] === "1";
}

/**
 * Count matching rows, decide whether to proceed, then run the DELETE.
 * Returns the result without throwing on the refuse path — the audit
 * row carries the refusal; the caller decides whether a refusal is
 * itself a hard error in their context.
 */
export async function safeBulkDelete<TTable extends PgTable>(
  opts: SafeBulkDeleteOptions<TTable>,
): Promise<SafeBulkDeleteResult> {
  const startedAt = new Date();
  const threshold = opts.threshold ?? DEFAULT_BULK_DELETE_THRESHOLD;
  const detailBase = `table=${opts.tableLabel} threshold=${threshold}`;

  // Count first so we know whether to refuse before we mutate anything.
  const countRows = await db.execute<{ c: string }>(
    sql`SELECT count(*)::text AS c FROM ${opts.table} WHERE ${opts.where}`,
  );
  const matched = Number(countRows.rows[0]?.c ?? 0);

  if (matched === 0) {
    await recordMutation({
      routine: opts.routine,
      outcome: "noop",
      rowsAffected: 0,
      startedAt,
      detail: `${detailBase} matched=0`,
    });
    return { outcome: "noop", matched: 0, deleted: 0 };
  }

  if (isProduction() && matched > threshold && !isOptedIn()) {
    logger.error(
      {
        routine: opts.routine,
        table: opts.tableLabel,
        matched,
        threshold,
        env: BULK_DELETE_OPT_IN_ENV,
      },
      "safeBulkDelete refused in production (set KFI_ALLOW_BULK_PUNCH_DELETE=1 to bypass)",
    );
    await recordMutation({
      routine: opts.routine,
      outcome: "refused",
      rowsAffected: 0,
      startedAt,
      detail: `${detailBase} matched=${matched} refused=production-guard`,
    });
    return { outcome: "refused", matched, deleted: 0 };
  }

  const del = await db.execute<{ id: unknown }>(
    sql`DELETE FROM ${opts.table} WHERE ${opts.where} RETURNING 1 AS id`,
  );
  const deleted = del.rowCount ?? del.rows.length ?? 0;

  await recordMutation({
    routine: opts.routine,
    outcome: "ok",
    rowsAffected: deleted,
    startedAt,
    detail: `${detailBase} matched=${matched} deleted=${deleted}`,
  });

  if (isProduction() && isOptedIn()) {
    logger.warn(
      { routine: opts.routine, table: opts.tableLabel, deleted, matched },
      "safeBulkDelete allowed by explicit opt-in",
    );
  }

  return { outcome: "ok", matched, deleted };
}

/**
 * Inline guard for runtime route handlers that delete punches in bulk
 * inside an existing transaction (Task #402). Counts matching rows
 * via the supplied executor, refuses with `BulkDeleteRefusedError` in
 * production over threshold (unless KFI_ALLOW_BULK_PUNCH_DELETE=1),
 * and returns a `recordOk(deleted)` callback the caller invokes after
 * doing its own DELETE (with .returning() etc.) so every outcome —
 * `noop`, `ok`, or `refused` — lands one row in `data_mutation_audit`.
 *
 * The audit insert uses the global `db` rather than the transaction
 * so a transactional rollback never erases the evidence that the
 * routine ran.
 */
export interface PunchDeleteExecutor {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface GuardPunchDeleteOptions {
  routine: string;
  where: SQL;
  executor: PunchDeleteExecutor;
  threshold?: number;
}

export interface GuardPunchDeleteResult {
  matched: number;
  recordOk: (deleted: number) => Promise<void>;
}

export async function guardBulkPunchDelete(
  opts: GuardPunchDeleteOptions,
): Promise<GuardPunchDeleteResult> {
  const startedAt = new Date();
  const threshold = opts.threshold ?? RUNTIME_PUNCH_DELETE_THRESHOLD;
  const countRows = await opts.executor.execute(
    sql`SELECT count(*)::text AS c FROM ${schema.punchesTable} WHERE ${opts.where}`,
  );
  const matched = Number((countRows.rows[0]?.c as string | undefined) ?? 0);
  if (matched === 0) {
    await recordMutation({
      routine: opts.routine,
      outcome: "noop",
      rowsAffected: 0,
      startedAt,
      detail: `table=punches threshold=${threshold} matched=0`,
    });
    return { matched: 0, recordOk: async () => {} };
  }
  if (isProduction() && matched > threshold && !isOptedIn()) {
    logger.error(
      { routine: opts.routine, matched, threshold },
      "guardBulkPunchDelete refused in production (set KFI_ALLOW_BULK_PUNCH_DELETE=1 to bypass)",
    );
    await recordMutation({
      routine: opts.routine,
      outcome: "refused",
      rowsAffected: 0,
      startedAt,
      detail: `table=punches threshold=${threshold} matched=${matched} refused=production-guard`,
    });
    throw new BulkDeleteRefusedError(
      opts.routine,
      "punches",
      matched,
      threshold,
    );
  }
  return {
    matched,
    recordOk: async (deleted: number) => {
      await recordMutation({
        routine: opts.routine,
        outcome: deleted > 0 ? "ok" : "noop",
        rowsAffected: deleted,
        startedAt,
        detail: `table=punches threshold=${threshold} matched=${matched} deleted=${deleted}`,
      });
    },
  };
}
