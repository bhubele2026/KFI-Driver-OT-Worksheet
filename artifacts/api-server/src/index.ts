// MUST stay first — Sentry.init has to run before anything else is imported.
import "./instrument";
import * as Sentry from "@sentry/node";
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
import {
  backfillPayrollProfilesFromZenople,
  zenopleConfigured,
} from "./lib/zenopleRates";
import { hasRunThisDeploy, recordMutation } from "./lib/dataMutationAudit";
import { autoAlignWeek } from "./lib/punchAutoAlign";

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

  // Clean-slate import rebuild: the schema-cache lane (and its legacy-row
  // boot cleanup) was removed — every upload is one fast model call.

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

    // 2026-09-09 — get the three people Tiana reported importing, without
    // her having to click anything.
    //
    // ⚠️ This lives at BOOT, not in preMigrate. The container CMD is just
    // `node dist/index.mjs`; `pnpm --filter @workspace/db run push` (which is
    // what runs preMigrate) is NOT part of a deploy, so a fixup put there
    // would never have executed. Boot seeds like seedDriverPayrollProfiles
    // above are the pattern that actually runs.
    //
    // Willie Medina and Luis Ceballos Martinez each carry a "not a driver"
    // rule at Burnett. Since v97 an ignore is unrecoverable from the upload
    // flow — a vetoed row never reaches the picker, and only a picker pick
    // clears it — so no amount of clicking could have fixed this. Aldo
    // Ramirez was lost to the zero-Connecteam rule instead; pinning his badge
    // makes his identity "certain", which that rule now honours.
    //
    // Marker-gated: a rule a dispatcher deliberately re-adds later must NOT
    // be resurrected by the next deploy.
    {
      const fixClient = await pool.connect();
      const fixStartedAt = new Date();
      const MARKER = "seed_tiana_three_imports_2026_09_09";
      try {
        await fixClient.query(`
          CREATE TABLE IF NOT EXISTS schema_fixup_markers (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          )`);
        const already = await fixClient.query(
          `SELECT 1 FROM schema_fixup_markers WHERE name = $1`,
          [MARKER],
        );
        if (already.rowCount) {
          await recordMutation({
            routine: "seedTianaThreeImports",
            outcome: "noop",
            rowsAffected: 0,
            startedAt: fixStartedAt,
            detail: "marker already present",
          });
        } else {
          // Scoped to ONE customer and to exact keys — never a wildcard. The
          // other ~30 Burnett "not a driver" rules are correct and stay.
          // customer_ignored_externals is keyed (lower(customer),
          // lower(external_id)) where external_id is a badge OR a
          // `name:<name-on-doc>` sentinel, so both shapes must go.
          const cleared = await fixClient.query(
            `DELETE FROM customer_ignored_externals
              WHERE lower(customer) = lower($1)
                AND lower(external_id) = ANY($2::text[])`,
            [
              "Burnett Dairy - Grantsburg",
              [
                "10658",
                "10542",
                "name:anthony medina",
                "name:medina, anthony",
                "name:willie medina",
                "name:medina jr, willie a",
                "name:luis ceballos martinez",
                "name:ceballos martinez, luis",
                "name:ceballos martinez, luis e",
              ],
            ],
          );
          // driver_id_aliases.kfi_id has an FK to drivers.kfi_id, so a plain
          // INSERT would throw for anyone missing from the roster. Insert on
          // EXISTS instead and report the misses: no drivers row means the
          // person is absent from Connecteam entirely, and then NOTHING here
          // can import them. That is a finding, not a silent no-op.
          const pinned = await fixClient.query(
            `INSERT INTO driver_id_aliases (external_id, kfi_id, customer, sample_name, note)
             SELECT v.external_id, v.kfi_id, v.customer, v.sample_name,
                    'Seeded 2026-09-09: reported missing from the customer import.'
               FROM (VALUES
                 ('10658', '2004792', 'Burnett Dairy - Grantsburg',     'MEDINA JR, WILLIE A'),
                 ('10542', '2003301', 'Burnett Dairy - Grantsburg',     'CEBALLOS MARTINEZ, LUIS E'),
                 ('10077', '2006019', 'Shuster''s Building Components', 'RAMIREZ, ALDO NOE')
               ) AS v(external_id, kfi_id, customer, sample_name)
              WHERE EXISTS (SELECT 1 FROM drivers d WHERE d.kfi_id = v.kfi_id)
             ON CONFLICT (external_id) DO NOTHING
             RETURNING external_id, kfi_id`,
          );
          const missing = await fixClient.query(
            `SELECT v.kfi_id, v.sample_name
               FROM (VALUES
                 ('2004792', 'MEDINA JR, WILLIE A'),
                 ('2003301', 'CEBALLOS MARTINEZ, LUIS E'),
                 ('2006019', 'RAMIREZ, ALDO NOE')
               ) AS v(kfi_id, sample_name)
              WHERE NOT EXISTS (SELECT 1 FROM drivers d WHERE d.kfi_id = v.kfi_id)`,
          );
          if (missing.rowCount) {
            logger.warn(
              {
                missing: missing.rows.map(
                  (r: { kfi_id: string; sample_name: string }) =>
                    `${r.kfi_id} (${r.sample_name})`,
                ),
              },
              "seedTianaThreeImports: no drivers row — badge NOT pinned, and this person still will not import (absent from Connecteam)",
            );
          }
          await fixClient.query(
            `INSERT INTO schema_fixup_markers (name) VALUES ($1)
             ON CONFLICT (name) DO NOTHING`,
            [MARKER],
          );
          const detail = `ignoresCleared=${cleared.rowCount ?? 0} badgesPinned=${pinned.rowCount ?? 0} noDriverRow=${missing.rowCount ?? 0}`;
          logger.info({ detail }, "seedTianaThreeImports complete");
          await recordMutation({
            routine: "seedTianaThreeImports",
            outcome:
              (cleared.rowCount ?? 0) + (pinned.rowCount ?? 0) > 0 ? "ok" : "noop",
            rowsAffected: (cleared.rowCount ?? 0) + (pinned.rowCount ?? 0),
            startedAt: fixStartedAt,
            detail,
          });
        }
      } catch (err) {
        await recordMutation({
          routine: "seedTianaThreeImports",
          outcome: "error",
          rowsAffected: 0,
          startedAt: fixStartedAt,
          detail: err instanceof Error ? err.message : String(err),
        });
        if (process.env.NODE_ENV !== "production") throw err;
        logger.warn({ err }, "seedTianaThreeImports failed");
      } finally {
        fixClient.release();
      }
    }

    // Auto-align sweep: heal whole-day ±1h Connecteam device-clock errors
    // for the current + previous two weeks (idempotent — an aligned week
    // has nothing left in the ±1h anomaly band). Audited like every boot
    // write (republish-safety).
    {
      const alignClient = await pool.connect();
      const alignStartedAt = new Date();
      try {
        const weeks: string[] = [];
        {
          const now = new Date();
          const sunday = new Date(now);
          sunday.setUTCDate(now.getUTCDate() - now.getUTCDay());
          for (let i = 0; i < 3; i++) {
            const d = new Date(sunday);
            d.setUTCDate(sunday.getUTCDate() - 7 * i);
            weeks.push(d.toISOString().slice(0, 10));
          }
        }
        let daysShifted = 0;
        let punchesShifted = 0;
        const details: string[] = [];
        for (const wk of weeks) {
          const r = await autoAlignWeek(alignClient, wk);
          daysShifted += r.daysShifted;
          punchesShifted += r.punchesShifted;
          details.push(...r.details);
        }
        logger.info(
          { weeks, daysShifted, punchesShifted, details },
          "punch auto-align sweep complete",
        );
        await recordMutation({
          routine: "punchAutoAlignSweep",
          outcome: daysShifted > 0 ? "ok" : "noop",
          rowsAffected: punchesShifted,
          startedAt: alignStartedAt,
          detail: `weeks=${weeks.join(",")} days=${daysShifted} punches=${punchesShifted} ${details.join("; ")}`,
        });
      } catch (err) {
        await recordMutation({
          routine: "punchAutoAlignSweep",
          outcome: "error",
          rowsAffected: 0,
          startedAt: alignStartedAt,
          detail: err instanceof Error ? err.message : String(err),
        });
        logger.warn({ err }, "punch auto-align sweep failed");
      } finally {
        alignClient.release();
      }
    }

    // Zenople rate backfill — fills NULL pay/bill fields for active drivers
    // from AssignmentData/TransactionData. Additive only (never overwrites),
    // audited, and a silent no-op when ZENOPLE_* env is absent.
    // ⚠️ ONCE PER DEPLOY, NOT ONCE PER BOOT. This used to run on every container
    // start — so a crash-loop, a scale-out replica or a restart each re-pulled
    // AssignmentData + TransactionData. The audit row was only written AFTER the
    // work, so nothing consulted it first. Now it is the guard.
    if (zenopleConfigured() && !(await hasRunThisDeploy("backfillPayrollProfilesFromZenople"))) {
      const zClient = await pool.connect();
      const zStartedAt = new Date();
      try {
        const zResult = await backfillPayrollProfilesFromZenople(zClient);
        logger.info({ zResult }, "backfillPayrollProfilesFromZenople complete");
        await recordMutation({
          routine: "backfillPayrollProfilesFromZenople",
          outcome: zResult.fieldsFilled > 0 ? "ok" : "noop",
          rowsAffected: zResult.driversFilled,
          startedAt: zStartedAt,
          detail: `considered=${zResult.driversConsidered} filled=${zResult.driversFilled} fields=${zResult.fieldsFilled} noMatch=${zResult.noZenopleMatch.length} ambiguous=${zResult.ambiguousNames.length} identity=${zResult.identityWritten ? "live" : "manual"}`,
        });
      } catch (err) {
        await recordMutation({
          routine: "backfillPayrollProfilesFromZenople",
          outcome: "error",
          rowsAffected: 0,
          startedAt: zStartedAt,
          detail: err instanceof Error ? err.message : String(err),
        });
        logger.warn({ err }, "backfillPayrollProfilesFromZenople failed");
      } finally {
        zClient.release();
      }
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

  // Registered after every route/middleware is mounted (app.ts wires them at
  // import time) and before listen. No-ops when SENTRY_DSN is absent.
  Sentry.setupExpressErrorHandler(app);

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
      // Read-only contradiction audit: ids that carry BOTH a "not a
      // driver" ignore rule and a saved alias. Since 2026-09-01 the
      // ignore VETOES the alias at import time (Davis→Navarro), so each
      // pair means "that alias is suppressed for that customer" — worth
      // a look on /admin/driver-id-aliases, never auto-fixed here.
      try {
        const { db } = await import("./lib/db.js");
        const { sql } = await import("drizzle-orm");
        const contradictions = await db.execute(sql`
          SELECT i.customer, i.external_id
          FROM customer_ignored_externals i
          JOIN driver_id_aliases a
            ON lower(a.external_id) = lower(i.external_id)
          UNION
          SELECT i.customer, i.external_id
          FROM customer_ignored_externals i
          JOIN customer_name_aliases n
            ON lower(n.customer) = lower(i.customer)
           AND 'name:' || lower(n.name_on_doc) = lower(i.external_id)
          LIMIT 50
        `);
        const rows = contradictions.rows as Array<{
          customer: string;
          external_id: string;
        }>;
        if (rows.length > 0) {
          logger.warn(
            {
              count: rows.length,
              samples: rows
                .slice(0, 10)
                .map((r) => `${r.customer} · ${r.external_id}`),
            },
            "ignore rules overriding saved aliases — review on /admin/driver-id-aliases",
          );
        }
      } catch (contradictionErr) {
        logger.warn(
          { err: contradictionErr },
          "ignore/alias contradiction audit failed",
        );
      }
    })();
  });
}

void main();
