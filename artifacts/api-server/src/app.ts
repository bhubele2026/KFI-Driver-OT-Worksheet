import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { buildSessionMiddleware } from "./lib/auth";

const app: Express = express();

app.set("trust proxy", 1);

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
app.use(cors({ origin: true, credentials: true }));
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
  app.use(express.static(webDir, { index: false, maxAge: "1h" }));
  // SPA history fallback: serve index.html for any non-API GET that isn't a
  // real asset request, so client-side routes (/worksheet, /admin/*, …) load.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/")) return next();
    if (req.path.includes(".")) return next(); // let missing assets 404
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
