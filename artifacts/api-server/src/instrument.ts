// Sentry bootstrap — must be the FIRST import of index.ts so init runs before
// any request handling or module side effects. Mirrors the Financial
// Dashboard's apps/api/src/instrument.ts.
import * as Sentry from "@sentry/node";

const dsn = process.env["SENTRY_DSN"];
if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env["NODE_ENV"] === "production" ? "production" : "development",
    release: process.env["APP_VERSION"] ?? "dev",
    // Errors only — the org is on the free tier, and tracing buys little on an
    // app whose slow path was transfer size, not span depth.
    tracesSampleRate: 0,
    integrations: [
      // Route handlers here log failures via pino/console.error rather than
      // rethrowing; this captures those without touching a single route.
      Sentry.captureConsoleIntegration({ levels: ["error"] }),
      // Report an uncaught exception, but do NOT exit — index.ts installs
      // deliberate keep-alive handlers and Sentry's default would defeat them.
      Sentry.onUncaughtExceptionIntegration({
        exitEvenIfOtherHandlersAreRegistered: false,
      }),
    ],
  });
}
