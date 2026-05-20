import app from "./app";
import { logger } from "./lib/logger";
import { initMailer } from "./lib/mailer";
import { ensureAtLeastOneAdmin } from "./lib/adminBootstrap";
import { repairBogusObjectCustomers } from "./lib/repairBogusCustomers";
import { pool } from "./lib/db";
import {
  createPostgresBackend,
  setRateLimitBackend,
  setRateLimitEventSink,
  startPostgresBackendCleanup,
  startRateLimitEventsCleanup,
} from "./lib/rateLimit";
import { startAiExtractSampleCleanup } from "./lib/aiExtractSampleCleanup";
import { startAiExtractChunkStageCleanup } from "./lib/parsers/aiExtractStage";
import { startHiddenNotesDigest } from "./lib/hiddenNotesDigest";
import { initIpBlocklist } from "./lib/ipBlocklist";
import { startRealtimeHeartbeat } from "./lib/realtime";
import { seedDriverPayrollProfiles } from "@workspace/db/seedDriverPayrollProfiles";
import { deleteLegacyParserSchemaRows } from "./lib/parsers/schemaLookup";
import { recordMutation } from "./lib/dataMutationAudit";

// Captured once at module load so the boot-summary log can scope its
// audit query to "rows whose startedAt >= this boot's start" — see the
// summary block at the end of main().
const BOOT_STARTED_AT = new Date();

if (process.env.NODE_ENV === "production") {
  if (!process.env.APP_BASE_URL && !process.env.REPLIT_DOMAINS) {
    throw new Error("APP_BASE_URL is required in production");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  // Email delivery is disabled; initMailer is a no-op kept for shape.
  await initMailer().catch((err) => {
    logger.warn({ err }, "initMailer failed");
  });

  try {
    await ensureAtLeastOneAdmin();
  } catch (err) {
    logger.error({ err }, "ensureAtLeastOneAdmin failed");
    process.exit(1);
  }

  // Fire-and-forget: never block server start on a Connecteam round-trip,
  // and never crash boot if the repair fails — it's idempotent and re-runs
  // on the next boot.
  void repairBogusObjectCustomers().catch((err) => {
    logger.warn({ err }, "repairBogusObjectCustomers threw");
  });

  try {
    await initIpBlocklist();
  } catch (err) {
    logger.warn({ err }, "initial ip blocklist load failed");
  }

  setRateLimitBackend(createPostgresBackend(pool));
  startPostgresBackendCleanup(pool, {
    onError: (err) => logger.warn({ err }, "rate limit cleanup failed"),
  });
  startRateLimitEventsCleanup(pool, {
    onError: (err) =>
      logger.warn({ err }, "rate limit events cleanup failed"),
  });
  startAiExtractSampleCleanup();
  startAiExtractChunkStageCleanup();
  startHiddenNotesDigest();
  startRealtimeHeartbeat();

  // Task #277: legacy hand-written parsers were removed; every upload
  // now flows through the AI-first pipeline (cache → AI → cache write).
  // Drop any leftover legacy-parser sentinel rows from the old boot
  // seed so they don't clutter the table. Idempotent: no-op once gone.
  try {
    const cleanup = await deleteLegacyParserSchemaRows();
    if (cleanup.deleted > 0) {
      logger.info(
        { deleted: cleanup.deleted },
        "deleteLegacyParserSchemaRows cleaned legacy customer_column_schemas",
      );
    }
  } catch (err) {
    logger.warn({ err }, "deleteLegacyParserSchemaRows failed");
    // safeBulkDelete already wrote its own audit row on the happy paths; on
    // throw we still want a marker so /admin/boot-audit shows the failed boot.
    await recordMutation({
      routine: "deleteLegacyParserSchemaRows",
      outcome: "error",
      rowsAffected: 0,
      startedAt: new Date(),
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  void (async () => {
    const client = await pool.connect();
    try {
      const exists = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = 'driver_payroll_profiles'
         ) AS exists`,
      );
      if (!exists.rows[0]?.exists) {
        // Missing the table is a real bug: post-merge `pnpm db push`
        // didn't run, or the schema barrel doesn't export it. In dev
        // we crash loudly so the next regression is impossible to
        // miss; in prod we log + carry on so a transient startup race
        // doesn't take the API down.
        const msg =
          "driver_payroll_profiles table missing — run `pnpm --filter @workspace/db run push`";
        if (process.env.NODE_ENV !== "production") throw new Error(msg);
        logger.error({}, msg);
        return;
      }
      const seedStartedAt = new Date();
      const result = await seedDriverPayrollProfiles(client);
      logger.info({ result }, "seedDriverPayrollProfiles complete");
      await recordMutation({
        routine: "seedDriverPayrollProfiles",
        outcome: result.inserted > 0 ? "ok" : "noop",
        rowsAffected: result.inserted,
        startedAt: seedStartedAt,
        detail: `matched=${result.matched} inserted=${result.inserted} skippedExisting=${result.skippedExisting} unmatched=${result.unmatched.length}`,
      });
    } catch (err) {
      await recordMutation({
        routine: "seedDriverPayrollProfiles",
        outcome: "error",
        rowsAffected: 0,
        startedAt: new Date(),
        detail: err instanceof Error ? err.message : String(err),
      });
      if (process.env.NODE_ENV !== "production") throw err;
      logger.warn({ err }, "seedDriverPayrollProfiles failed");
    } finally {
      client.release();
    }
  })();

  setRateLimitEventSink((event) => {
    pool
      .query(
        `INSERT INTO rate_limit_events (name, key, blocked_at, expired_at)
         VALUES ($1, $2, $3, $4)`,
        [event.name, event.key, event.blockedAt, event.expiredAt],
      )
      .catch((err) =>
        logger.warn(
          { err, name: event.name, key: event.key },
          "rate limit event insert failed",
        ),
      );
  });

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    // Task #402 — single boot-summary line so an operator can grep
    // "boot complete" and confirm at a glance that this republish ran
    // without firing any of the boot-time mutation routines in anger.
    // The audit table at /admin/boot-audit is the persisted version.
    // Boot-scoped summary: wait briefly so the async boot routines
    // (repairBogusObjectCustomers, seedDriverPayrollProfiles) settle,
    // then count audit rows whose startedAt is at-or-after THIS
    // process's boot timestamp. That prevents a stale prior-boot row
    // from polluting the summary (false mutation warning) and prevents
    // a freshly written mutation row from being missed because the
    // routine hadn't finished yet (false clean).
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 3000));
        const { db, schema } = await import("./lib/db.js");
        const { desc, gte, eq, and } = await import("drizzle-orm");
        const recent = await db
          .select({
            routine: schema.dataMutationAuditTable.routine,
            outcome: schema.dataMutationAuditTable.outcome,
            rowsAffected: schema.dataMutationAuditTable.rowsAffected,
          })
          .from(schema.dataMutationAuditTable)
          .where(
            and(
              gte(schema.dataMutationAuditTable.startedAt, BOOT_STARTED_AT),
              process.env.NODE_ENV
                ? eq(
                    schema.dataMutationAuditTable.nodeEnv,
                    process.env.NODE_ENV,
                  )
                : undefined,
            ),
          )
          .orderBy(desc(schema.dataMutationAuditTable.startedAt))
          .limit(50);
        const totalRowsAffected = recent.reduce(
          (acc, r) => acc + (r.rowsAffected ?? 0),
          0,
        );
        // A boot is "clean" only when every audit row this process wrote
        // is outcome=ok|noop AND total rows affected is zero. An `error`
        // or `refused` row can have rowsAffected=0 (the guard refused
        // before deleting anything), so we must not let that masquerade
        // as a clean boot — that's the whole point of the audit.
        const hadNonCleanOutcome = recent.some(
          (r) => r.outcome !== "ok" && r.outcome !== "noop",
        );
        if (totalRowsAffected === 0 && !hadNonCleanOutcome) {
          logger.info(
            { sampled: recent.length, deploymentId: process.env.REPLIT_DEPLOYMENT_ID ?? null },
            "boot complete: no mutations",
          );
        } else {
          logger.warn(
            {
              recent,
              totalRowsAffected,
              hadNonCleanOutcome,
              deploymentId: process.env.REPLIT_DEPLOYMENT_ID ?? null,
            },
            "boot complete: mutations or non-clean outcomes recorded — see /admin/boot-audit",
          );
        }
      } catch (auditErr) {
        logger.warn({ err: auditErr }, "boot summary log failed");
      }
    })();
  });
}

void main();
