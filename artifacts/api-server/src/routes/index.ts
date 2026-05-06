import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { authRouter } from "./auth.js";
import { weeksRouter } from "./weeks.js";
import { punchesRouter } from "./punches.js";
import { ipBlocklistMiddleware } from "../lib/ipBlocklist.js";

const router: IRouter = Router();

// Reject blocklisted IPs before any other route — including the rate limiter.
router.use(ipBlocklistMiddleware);

router.use(healthRouter);
router.use(authRouter);
router.use(weeksRouter);
router.use(punchesRouter);

export default router;
