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
// The admin surface is the OWNER's settings area (2026-09-01: Settings left
// the tile grid for the gear, "only I can get to" — Brad). One gate here
// rather than threading it through dozens of routes; requireAdmin still
// applies on top per route. Operational admin endpoints that staff use daily
// (the Zenople export, week resets) live OUTSIDE /admin and are untouched.
//
// ⚠️ 2026-09-08: the gate is a PATH PREFIX, and it over-reached. It caught
// day-to-day matching tables a dispatcher needs to fix her own import — and
// because it sits above the per-route guards, the pages render in full and
// only the fetch 403s, so the symptom is an empty table rather than "no
// access". Tiana lost the ability to re-map a mis-matched driver this way.
//
// These paths are DISPATCHER tools, not owner settings: they stay behind
// their own per-route requireAdmin / requireSupervisorOrAdmin, which is the
// access level they always wanted. Everything else under /admin — users,
// tile access, activity, boot audit, realtime, AI samples — stays owner-only.
// Exempting here (rather than renaming the routes) keeps every URL and the
// generated API client unchanged.
const ADMIN_PATHS_FOR_DISPATCHERS = [
  "/customer-import-rules",
  "/connecteam-user-aliases",
  "/clock-offsets",
  "/customers",
  "/drivers",
];
router.use("/admin", (req, res, next) => {
  // req.path is relative to the "/admin" mount point. Fail CLOSED: anything
  // with a traversal segment goes to the owner gate rather than being matched
  // against the exemption list, so no encoding trick can turn a prefix match
  // on an allowed path into a pass for an owner-only one.
  const path = req.path;
  const isDispatcherTool =
    !path.split("/").includes("..") &&
    ADMIN_PATHS_FOR_DISPATCHERS.some(
      (p) => path === p || path.startsWith(`${p}/`),
    );
  if (isDispatcherTool) return next();
  return requireOwner(req, res, next);
});

router.use(authRouter);
router.use(tilesRouter);
router.use(weeksRouter);
router.use(punchesRouter);
router.use(payrollRouter);
router.use(payrollRunRouter);
router.use(copilotRouter);

export default router;
