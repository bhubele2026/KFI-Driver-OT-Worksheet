import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Running server's build tag (APP_VERSION baked at image build). The SPA
// polls this and shows a "new version — refresh" banner when its own baked
// VITE_APP_VERSION no longer matches. Public on purpose: it must work from
// any screen, and it leaks nothing but the version string.
router.get("/app-version", (_req, res) => {
  res.json({ version: process.env.APP_VERSION ?? null });
});

export default router;
