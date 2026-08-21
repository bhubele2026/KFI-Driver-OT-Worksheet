import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { timingSafeEqual } from "node:crypto";
import { desc, isNull, inArray, sql } from "drizzle-orm";
import { GetPulseResponse } from "@workspace/api-zod";
import { db, pool, schema } from "../lib/db.js";
import { computeReadiness } from "./payroll.js";
import { DEFAULT_CLAUDE_MODEL } from "../lib/parsers/claude.js";
import { isPricedModel } from "../lib/parsers/pricing.js";
import { zenopleStats } from "../lib/zenopleClient.js";

/**
 * Machine feed for the Master Dash (Financial Dashboard). Auth is a shared
 * secret in the x-pulse-key header — this app has no Easy Auth and its
 * session cookies can't be minted by a sibling server. Everything returned
 * is aggregate or identity-scrubbed; SSNs never appear on this surface
 * (export snapshots are stored SSN-stripped at write time).
 */
// Exported so the machine feed in machine.ts uses THIS guard rather than a
// second copy of it. Two implementations of one security check is how they
// drift apart.
export function requirePulseKey(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.PULSE_SHARED_SECRET;
  if (!secret) {
    res.status(503).json({ error: "pulse not configured" });
    return;
  }
  const given = Buffer.from(String(req.header("x-pulse-key") ?? ""));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const router: IRouter = Router();

router.get("/pulse", requirePulseKey, async (req, res) => {
  const t0 = Date.now();
  let dbOk = true;
  try {
    await pool.query("select 1");
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - t0;

  // Recent weeks, newest first. Readiness is recomputed live (it is the
  // same code path the export gate uses), capped at 6 weeks to keep the
  // response fast — the tie-out engine only reconciles recent periods.
  const weekRows = dbOk
    ? await db
        .select({ startDate: schema.weeksTable.startDate })
        .from(schema.weeksTable)
        .orderBy(desc(schema.weeksTable.startDate))
        .limit(6)
    : [];
  const weekStarts = weekRows.map((w) => w.startDate);

  // Latest export snapshot per week (rates were merged live at export time,
  // so these totals are the only true record of what Zenople was sent).
  const snaps = weekStarts.length
    ? await db
        .select({
          weekStart: schema.exportSnapshotsTable.weekStart,
          ppe: schema.exportSnapshotsTable.ppe,
          createdAt: schema.exportSnapshotsTable.createdAt,
          rowCount: schema.exportSnapshotsTable.rowCount,
          driverCount: schema.exportSnapshotsTable.driverCount,
          totals: schema.exportSnapshotsTable.totals,
        })
        .from(schema.exportSnapshotsTable)
        .where(inArray(schema.exportSnapshotsTable.weekStart, weekStarts))
        .orderBy(desc(schema.exportSnapshotsTable.createdAt))
    : [];
  const latestSnapByWeek = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) {
    if (!latestSnapByWeek.has(s.weekStart)) latestSnapByWeek.set(s.weekStart, s);
  }

  const weeks = [];
  for (const weekStart of weekStarts) {
    const r = await computeReadiness(weekStart);
    const snap = latestSnapByWeek.get(weekStart) ?? null;
    weeks.push({
      weekStart,
      readiness: {
        ready: r.ready,
        driversTotal: r.driversTotal,
        driversReady: r.driversReady,
        unreviewed: r.unreviewedKfiIds.length,
        missingProfile: r.missingProfileKfiIds.length,
      },
      export: snap
        ? {
            exportedAt: snap.createdAt.toISOString(),
            ppe: snap.ppe,
            rowCount: snap.rowCount,
            driverCount: snap.driverCount,
            totals: snap.totals,
          }
        : null,
    });
  }

  // Coverage gap: profiles without a Zenople PersonId can't be joined to
  // payroll facts — a per-driver tie-out silently loses them.
  const [{ n: nullPersonIds }] = dbOk
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.driverPayrollProfilesTable)
        .where(isNull(schema.driverPayrollProfilesTable.personId))
    : [{ n: -1 }];

  const extractModel = process.env.CLAUDE_EXTRACT_MODEL ?? DEFAULT_CLAUDE_MODEL;

  const body = GetPulseResponse.parse({
    ok: dbOk,
    service: "kfi-ot-worksheet",
    version: process.env.APP_VERSION ?? null,
    db: { ok: dbOk, ms: dbMs },
    config: {
      extractModel,
      extractModelPriced: isPricedModel(extractModel),
      repoDefaultModel: DEFAULT_CLAUDE_MODEL,
      publicBypassAuth: process.env.PUBLIC_BYPASS_AUTH === "1",
      sentryEnabled: Boolean(process.env.SENTRY_DSN),
    },
    weeks,
    gaps: { nullPersonIds },
    // A 429 no longer fails loudly (the client backs off and usually succeeds),
    // so `rateLimited` IS the signal that we are pressing Zenople's limits.
    zenople: zenopleStats(),
  });
  res.json(body);
});

export const pulseRouter = router;
