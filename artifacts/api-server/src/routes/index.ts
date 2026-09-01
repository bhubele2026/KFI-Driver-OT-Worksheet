import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { pulseRouter } from "./pulse.js";
import { machineRouter } from "./machine.js";
import { machinePayrollRouter } from "./machinePayroll.js";
import { authRouter } from "./auth.js";
import { tilesRouter } from "./tiles.js";
import { weeksRouter } from "./weeks.js";
import { punchesRouter } from "./punches.js";
import { payrollRouter } from "./payroll.js";
import { payrollRunRouter } from "./payrollRun.js";
import { copilotRouter } from "./copilot.js";
import { ipBlocklistMiddleware } from "../lib/ipBlocklist.js";
import { requireOwner } from "../lib/entraAuth.js";

const router: IRouter = Router();

// Reject blocklisted IPs before any other route — including the rate limiter.
router.use(ipBlocklistMiddleware);

router.use(healthRouter);
router.use(pulseRouter);
// Shared-secret machine feed, same key as pulse — deliberately NOT behind
// requireAuth: a sibling server cannot mint this app's session cookies.
router.use(machineRouter);
router.use(machinePayrollRouter);
// The whole admin surface is the OWNER's settings area (2026-09-01: Settings
// left the tile grid for the gear, "only I can get to" — Brad). One gate here
// rather than threading it through dozens of routes; requireAdmin still
// applies on top per route. Operational admin endpoints that staff use daily
// (the Zenople export, week resets) live OUTSIDE /admin and are untouched.
router.use("/admin", requireOwner);

router.use(authRouter);
router.use(tilesRouter);
router.use(weeksRouter);
router.use(punchesRouter);
router.use(payrollRouter);
router.use(payrollRunRouter);
router.use(copilotRouter);

export default router;
