import app from "./app";
import { logger } from "./lib/logger";
import { isMailerConfigured } from "./lib/mailer";
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
import { initIpBlocklist } from "./lib/ipBlocklist";
import { startRealtimeHeartbeat } from "./lib/realtime";

if (process.env.NODE_ENV === "production") {
  if (!process.env.APP_BASE_URL && !process.env.REPLIT_DOMAINS) {
    throw new Error("APP_BASE_URL is required in production");
  }
  if (!isMailerConfigured()) {
    throw new Error(
      "SMTP_HOST/SMTP_PORT must be set in production so password reset and invite emails can be delivered",
    );
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
  startRealtimeHeartbeat();
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
