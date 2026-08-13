import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "../lib/db.js";

const router: IRouter = Router();

// Polled every 30s by the Docker HEALTHCHECK and every few minutes by the
// Master Dash — keep it cheap (one `select 1`). "ok" must mean the app can
// actually serve: a dead DB reports status "degraded" with a 503 so the
// pulse board goes red instead of green-lying.
router.get("/healthz", async (_req, res) => {
  let dbOk = false;
  let ms = -1;
  const t0 = Date.now();
  try {
    await pool.query("select 1");
    dbOk = true;
    ms = Date.now() - t0;
  } catch {
    ms = Date.now() - t0;
  }
  const data = HealthCheckResponse.parse({
    status: dbOk ? "ok" : "degraded",
    version: process.env.APP_VERSION ?? null,
    db: { ok: dbOk, ms },
  });
  res.status(dbOk ? 200 : 503).json(data);
});

// Running server's build tag (APP_VERSION baked at image build). The SPA
// polls this and shows a "new version — refresh" banner when its own baked
// VITE_APP_VERSION no longer matches. Public on purpose: it must work from
// any screen, and it leaks nothing but the version string.
router.get("/app-version", (_req, res) => {
  res.json({ version: process.env.APP_VERSION ?? null });
});

export default router;
