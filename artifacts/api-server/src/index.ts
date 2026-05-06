import app from "./app";
import { logger } from "./lib/logger";
import { isMailerConfigured } from "./lib/mailer";
import { ensureAtLeastOneAdmin } from "./lib/adminBootstrap";
import { repairBogusObjectCustomers } from "./lib/repairBogusCustomers";
import { pool } from "./lib/db";
import {
  createPostgresBackend,
  setRateLimitBackend,
  startPostgresBackendCleanup,
} from "./lib/rateLimit";

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

  setRateLimitBackend(createPostgresBackend(pool));
  startPostgresBackendCleanup(pool, {
    onError: (err) => logger.warn({ err }, "rate limit cleanup failed"),
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
