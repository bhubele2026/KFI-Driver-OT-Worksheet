import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { authRouter } from "./auth.js";
import { weeksRouter } from "./weeks.js";
import { punchesRouter } from "./punches.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(weeksRouter);
router.use(punchesRouter);

export default router;
