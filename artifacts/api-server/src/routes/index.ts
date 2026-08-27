import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { pulseRouter } from "./pulse.js";
import { machineRouter } from "./machine.js";
import { authRouter } from "./auth.js";
import { tilesRouter } from "./tiles.js";
import { weeksRouter } from "./weeks.js";
import { punchesRouter } from "./punches.js";
import { payrollRouter } from "./payroll.js";
import { copilotRouter } from "./copilot.js";
import { ipBlocklistMiddleware } from "../lib/ipBlocklist.js";

const router: IRouter = Router();

// Reject blocklisted IPs before any other route — including the rate limiter.
router.use(ipBlocklistMiddleware);

router.use(healthRouter);
router.use(pulseRouter);
// Shared-secret machine feed, same key as pulse — deliberately NOT behind
// requireAuth: a sibling server cannot mint this app's session cookies.
router.use(machineRouter);
router.use(authRouter);
router.use(tilesRouter);
router.use(weeksRouter);
router.use(punchesRouter);
router.use(payrollRouter);
router.use(copilotRouter);

export default router;
