import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { buildSessionMiddleware } from "./lib/auth";

const app: Express = express();

app.set("trust proxy", 1);
// Don't advertise the framework.
app.disable("x-powered-by");

// ── Security headers ──────────────────────────────────────────────────
// The Financial Dashboard runs helmet with CSP + frameguard OFF because it's
// embedded as a Microsoft Teams tab and helmet's frame-ancestors would blank
// it. This app is never framed, so it gets the strict version.
//   style-src needs 'unsafe-inline': Tailwind/shadcn set inline styles for
//   animation delays and bar widths, and Radix injects them for positioning.
//   connect-src opens Sentry's ingest so error reports can leave the page.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "https://*.ingest.sentry.io", "https://*.ingest.us.sentry.io"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    // Cross-origin isolation would block the self-hosted font/image loads
    // without buying anything here (no SharedArrayBuffer use).
    crossOriginEmbedderPolicy: false,
  }),
);

// ── Compression ───────────────────────────────────────────────────────
// Azure Container Apps' ingress does NOT compress for us, so without this the
// SPA bundle went out at 1.47MB raw on every cold load (verified live: no
// content-encoding even when the request offered br+gzip). Same fix, and the
// same reason, as the Dashboard's v149.
// The one thing that must NOT be compressed is the realtime SSE stream
// (routes/weeks.ts sets text/event-stream) — buffering it would stall live
// updates. compression's default filter already declines that content type,
// but assert it rather than rely on mime-db.
app.use(
  compression({
    filter: (req, res) => {
      const type = res.getHeader("Content-Type");
      if (typeof type === "string" && type.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// ── CORS ──────────────────────────────────────────────────────────────
// Was `origin: true, credentials: true`, which reflects back WHATEVER origin
// asks and then allows credentials on it — any site could have driven this
// API with a visitor's session. The SPA is served from this same origin, so
// nothing legitimate needs cross-origin access; allow only our own base URL
// (plus localhost for `pnpm dev`).
const allowedOrigins = [
  process.env.APP_BASE_URL,
  ...(process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:5173", "http://localhost:23456", "http://localhost:8080"]),
].filter((o): o is string => !!o);

app.use(
  cors({
    origin(origin, cb) {
      // Same-origin and non-browser callers (curl, health probes) send no Origin.
      if (!origin) return cb(null, true);
      cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(buildSessionMiddleware());

app.use("/api", router);

// ── Static SPA (single-service) ───────────────────────────────────
// On Replit the frontend was a separate static artifact and Replit's router
// stitched it to /api. Off Replit (Azure Container Apps) this one service
// serves both: the built kfi-ot SPA plus /api. The web bundle is copied next
// to the built server (dist/public) at image-build time; WEB_DIST_DIR can
// override the location (used for local dev against kfi-ot/dist/public).
const webDir = process.env.WEB_DIST_DIR
  ? path.resolve(process.env.WEB_DIST_DIR)
  : fileURLToPath(new URL("./public", import.meta.url));

if (existsSync(path.join(webDir, "index.html"))) {
  // Vite content-hashes every filename under /assets, so those files can never
  // change meaning — cache them for a year. The old blanket `maxAge: "1h"`
  // made every visitor re-download the whole ~1.6MB bundle hourly for nothing.
  app.use(
    "/assets",
    express.static(path.join(webDir, "assets"), {
      index: false,
      immutable: true,
      maxAge: "1y",
    }),
  );
  // Everything else (favicon, manifest, …) is unhashed — revalidate.
  app.use(express.static(webDir, { index: false, maxAge: 0 }));
  // SPA history fallback: serve index.html for any non-API GET that isn't a
  // real asset request, so client-side routes (/worksheet, /admin/*, …) load.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/")) return next();
    if (req.path.includes(".")) return next(); // let missing assets 404
    // The shell must never be cached: it's what points at the current hashed
    // bundle, so a stale copy would pin users to an old deploy (and defeat the
    // version-refresh banner).
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(path.join(webDir, "index.html"));
  });
  logger.info({ webDir }, "serving kfi-ot SPA from api-server");
} else {
  logger.warn(
    { webDir },
    "kfi-ot SPA not found next to server; running API-only",
  );
}

export default app;
