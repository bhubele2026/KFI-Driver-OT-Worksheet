import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import "./index.css";
import "./i18n";

// Error tracking — prod bundles only, and only when a DSN was baked in at
// build time (az acr build --build-arg VITE_SENTRY_DSN=...). Local dev and any
// build without the arg stay silent. Mirrors the Financial Dashboard.
const dsn = import.meta.env.VITE_SENTRY_DSN;
if (import.meta.env.PROD && dsn) {
  Sentry.init({
    dsn,
    release: import.meta.env.VITE_APP_VERSION ?? "dev",
    environment: "production",
    tracesSampleRate: 0, // errors only — free-tier quota
  });
}

// Replaces the white screen a render crash used to produce. The error itself
// is reported by the ErrorBoundary; this gives the user a way back.
function CrashFallback() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center">
        <div className="text-lg font-semibold text-brand-navy">
          Something went wrong
        </div>
        <p className="mt-2 text-sm text-neutral-500">
          The error has been reported. Reload to keep working.
        </p>
        <button
          type="button"
          className="mt-4 rounded-md bg-brand-navy px-4 py-2 text-sm font-medium text-white"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary fallback={<CrashFallback />}>
    <App />
  </Sentry.ErrorBoundary>,
);
