import app from "./app";
import { logger } from "./lib/logger";
import { initMailer, isMailerConfigured } from "./lib/mailer";
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
import { startHiddenNotesDigest } from "./lib/hiddenNotesDigest";
import { initIpBlocklist } from "./lib/ipBlocklist";
import { startRealtimeHeartbeat } from "./lib/realtime";
import { seedDriverPayrollProfiles } from "@workspace/db/seedDriverPayrollProfiles";

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
  // Prime the SendGrid connector lookup so isMailerConfigured() reflects
  // reality before anything reads it (admin banner, prod boot check, etc).
  await initMailer().catch((err) => {
    logger.warn({ err }, "initMailer failed");
  });
  if (process.env.NODE_ENV === "production" && !isMailerConfigured()) {
    throw new Error(
      "SendGrid integration is not connected — wire it up via Replit integrations (or set SENDGRID_API_KEY) so password reset and invite emails can be delivered",
    );
  }

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
  startHiddenNotesDigest();
  startRealtimeHeartbeat();

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
      const result = await seedDriverPayrollProfiles(client);
      logger.info({ result }, "seedDriverPayrollProfiles complete");
    } catch (err) {
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

    logger.info(
      { port, mailerConfigured: isMailerConfigured() },
      "Server listening",
    );
  });
}

void main();
