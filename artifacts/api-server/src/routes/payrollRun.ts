import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { requireTile, type AuthedRequest } from "../lib/entraAuth.js";
import { PAYROLL_CHECKLIST, OFF_CYCLE_STEP_KEYS } from "../lib/payrollChecklist.js";
import {
  periodDatesFor, payDateFor, labelFor, isFriday, isoToExcelSerial, parsePeriodLabel,
} from "../lib/payrollPeriod.js";
import { pullPeriod, runTieOuts, rosterFrom } from "../lib/zenoplePayroll.js";
import { zenopleConfigured } from "../lib/zenopleClient.js";

export const payrollRunRouter: IRouter = Router();

const STATUSES = new Set(["pending", "in_progress", "done", "blocked", "skipped"]);
const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Make sure the step catalogue in the database matches the seed.
 *
 * Idempotent and safe to call on every request that needs steps: it inserts
 * what is missing and updates task text that has drifted, but never deletes.
 * A step that disappears from the seed is deactivated instead, because
 * `payroll_step_state` rows point at it and history should stay readable.
 */
async function ensureSteps(): Promise<Map<string, number>> {
  const existing = await db
    .select({ id: schema.payrollStepsTable.id, key: schema.payrollStepsTable.key,
              task: schema.payrollStepsTable.task, ordinal: schema.payrollStepsTable.ordinal })
    .from(schema.payrollStepsTable);
  const byKey = new Map(existing.map((r) => [r.key, r]));

  const missing = PAYROLL_CHECKLIST.filter((s) => !byKey.has(s.key));
  if (missing.length) {
    await db.insert(schema.payrollStepsTable).values(
      missing.map((s) => ({
        key: s.key, ordinal: s.ordinal, day: s.day, task: s.task,
        tile: s.tile, appliesOffCycle: OFF_CYCLE_STEP_KEYS.has(s.key),
      })),
    ).onConflictDoNothing();
  }

  for (const s of PAYROLL_CHECKLIST) {
    const cur = byKey.get(s.key);
    if (cur && (cur.task !== s.task || cur.ordinal !== s.ordinal)) {
      await db.update(schema.payrollStepsTable)
        .set({ task: s.task, ordinal: s.ordinal, day: s.day, tile: s.tile })
        .where(eq(schema.payrollStepsTable.key, s.key));
    }
  }

  const seedKeys = new Set(PAYROLL_CHECKLIST.map((s) => s.key));
  const stale = existing.filter((r) => !seedKeys.has(r.key)).map((r) => r.key);
  if (stale.length) {
    await db.update(schema.payrollStepsTable)
      .set({ active: false })
      .where(inArray(schema.payrollStepsTable.key, stale));
  }

  // Resolve parent ids now that every row exists.
  const all = await db
    .select({ id: schema.payrollStepsTable.id, key: schema.payrollStepsTable.key })
    .from(schema.payrollStepsTable);
  const idByKey = new Map(all.map((r) => [r.key, r.id]));
  for (const s of PAYROLL_CHECKLIST) {
    if (!s.parent) continue;
    const pid = idByKey.get(s.parent);
    const id = idByKey.get(s.key);
    if (pid && id) {
      await db.update(schema.payrollStepsTable)
        .set({ parentId: pid })
        .where(and(eq(schema.payrollStepsTable.id, id), eq(schema.payrollStepsTable.key, s.key)));
    }
  }
  return idByKey;
}

/** Find or create the period row for a pay date. */
async function ensurePeriod(payDate: string, isOffCycle: boolean) {
  const found = await db.select().from(schema.payrollPeriodsTable)
    .where(and(eq(schema.payrollPeriodsTable.payDate, payDate),
               eq(schema.payrollPeriodsTable.isOffCycle, isOffCycle)))
    .limit(1);
  if (found[0]) return found[0];

  // Off-cycle has no work week, so weekStart and ppe stay null.
  const d = isOffCycle ? null : periodDatesFor(payDate);
  const inserted = await db.insert(schema.payrollPeriodsTable).values({
    payDate,
    label: labelFor(payDate, isOffCycle),
    weekStart: d?.weekStart ?? null,
    ppe: d ? isoToExcelSerial(d.ppeDate) : null,
    isOffCycle,
  }).returning();
  return inserted[0]!;
}

/** Recent periods, newest first. */
payrollRunRouter.get("/payroll-run/periods", requireAuth, requireTile("payroll_process"),
  async (_req: Request, res: Response) => {
    const rows = await db.select().from(schema.payrollPeriodsTable)
      .orderBy(desc(schema.payrollPeriodsTable.payDate)).limit(60);
    res.json({ periods: rows, current: payDateFor(todayIso()) });
  });

/**
 * The checklist for one pay date, with this period's state attached.
 *
 * Creates the period on first view rather than requiring a separate step —
 * opening the board for an upcoming pay date IS the act of starting it.
 */
payrollRunRouter.get("/payroll-run/periods/:payDate/checklist", requireAuth,
  requireTile("payroll_process"), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    const isOffCycle = String(req.query.offCycle ?? "") === "1";
    if (!isOffCycle && !isFriday(payDate)) {
      // Not fatal — an off-cycle run pays on any weekday — but worth saying,
      // because a regular period on a Tuesday is nearly always a typo.
      res.status(400).json({ error: "a regular pay date must be a Friday; pass offCycle=1 for an off-cycle run" });
      return;
    }

    await ensureSteps();
    const period = await ensurePeriod(payDate, isOffCycle);

    const steps = await db.select().from(schema.payrollStepsTable)
      .where(eq(schema.payrollStepsTable.active, true))
      .orderBy(asc(schema.payrollStepsTable.ordinal));
    const state = await db.select().from(schema.payrollStepStateTable)
      .where(eq(schema.payrollStepStateTable.periodId, period.id));
    const byStep = new Map(state.map((s) => [s.stepId, s]));

    const applicable = steps.filter((s) => !period.isOffCycle || s.appliesOffCycle);
    res.json({
      period: {
        ...period,
        ...(period.isOffCycle ? {} : periodDatesFor(period.payDate)),
      },
      steps: applicable.map((s) => {
        const st = byStep.get(s.id);
        return {
          id: s.id, key: s.key, ordinal: s.ordinal, day: s.day, task: s.task,
          tile: s.tile, parentId: s.parentId,
          status: st?.status ?? "pending",
          blockedOn: st?.blockedOn ?? null,
          note: st?.note ?? null,
          completedAt: st?.completedAt ?? null,
        };
      }),
      counts: {
        total: applicable.length,
        done: applicable.filter((s) => byStep.get(s.id)?.status === "done").length,
        blocked: applicable.filter((s) => byStep.get(s.id)?.status === "blocked").length,
      },
    });
  });

/**
 * Move one step.
 *
 * Upsert and audit happen in ONE transaction, matching how driver-week edits
 * are recorded — a state change that is not audited is not a state change.
 */
payrollRunRouter.post("/payroll-run/periods/:payDate/steps/:stepKey", requireAuth,
  requireTile("payroll_process"), async (req: Request, res: Response) => {
    const a = req as AuthedRequest;
    const payDate = String(req.params.payDate);
    const stepKey = String(req.params.stepKey);
    const { status, note, blockedOn } = (req.body ?? {}) as
      { status?: string; note?: string; blockedOn?: string };

    if (status !== undefined && !STATUSES.has(status)) {
      res.status(400).json({ error: `status must be one of ${[...STATUSES].join(", ")}` });
      return;
    }
    if (status === "blocked" && !blockedOn && !note) {
      // A blocked step with no reason is the thing that gets forgotten.
      res.status(400).json({ error: "a blocked step needs blockedOn or a note" });
      return;
    }

    const isOffCycle = String(req.query.offCycle ?? "") === "1";
    const period = await ensurePeriod(payDate, isOffCycle);
    const step = (await db.select().from(schema.payrollStepsTable)
      .where(eq(schema.payrollStepsTable.key, stepKey)).limit(1))[0];
    if (!step) {
      res.status(404).json({ error: `unknown step ${stepKey}` });
      return;
    }

    const now = new Date();
    const row = {
      periodId: period.id,
      stepId: step.id,
      status: status ?? "in_progress",
      note: note ?? null,
      blockedOn: blockedOn ?? null,
      completedBy: status === "done" ? (a.user?.id ?? null) : null,
      completedAt: status === "done" ? now : null,
    };

    await db.transaction(async (tx) => {
      await tx.insert(schema.payrollStepStateTable).values(row)
        .onConflictDoUpdate({
          target: [schema.payrollStepStateTable.periodId, schema.payrollStepStateTable.stepId],
          set: {
            status: row.status, note: row.note, blockedOn: row.blockedOn,
            completedBy: row.completedBy, completedAt: row.completedAt, updatedAt: now,
          },
        });
      await tx.insert(schema.payrollStepAuditTable).values({
        periodId: period.id,
        stepKey,
        status: row.status,
        blockedOn: row.blockedOn,
        note: row.note,
        actorUserId: a.user?.id ?? null,
        actorEmail: a.user?.email ?? a.authEmail ?? null,
      });
    });

    res.json({ ok: true, periodId: period.id, stepKey, status: row.status });
  });

/**
 * Carry unresolved work forward.
 *
 * The checklist's own last steps say to move unresolved items and pro-rate
 * stops to the next period, so that carry is modelled rather than left to
 * memory: every blocked step becomes a blocked step on the next period with
 * its reason intact.
 */
payrollRunRouter.post("/payroll-run/periods/:payDate/carry-forward", requireAuth,
  requireTile("payroll_process"), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    const from = await ensurePeriod(payDate, false);
    const nextPay = periodDatesFor(payDate).payDate;
    const to = await ensurePeriod(
      new Date(Date.parse(`${nextPay}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10),
      false,
    );

    const blocked = await db.select().from(schema.payrollStepStateTable)
      .where(and(eq(schema.payrollStepStateTable.periodId, from.id),
                 eq(schema.payrollStepStateTable.status, "blocked")));
    if (!blocked.length) {
      res.json({ ok: true, carried: 0, toPeriod: to.label });
      return;
    }
    await db.insert(schema.payrollStepStateTable).values(
      blocked.map((b) => ({
        periodId: to.id, stepId: b.stepId, status: "blocked",
        blockedOn: b.blockedOn,
        note: b.note ? `carried from ${from.label}: ${b.note}` : `carried from ${from.label}`,
      })),
    ).onConflictDoNothing();

    res.json({ ok: true, carried: blocked.length, toPeriod: to.label });
  });

/** Resolve a folder name like "PD 08.28.2026 Off Cycle" into a period. */
payrollRunRouter.get("/payroll-run/resolve", requireAuth, requireTile("payroll_process"),
  (req: Request, res: Response) => {
    const label = String(req.query.label ?? "");
    const parsed = parsePeriodLabel(label);
    if (!parsed) {
      res.status(400).json({ error: "not a PD folder name" });
      return;
    }
    res.json({
      ...parsed,
      ...(parsed.isOffCycle ? {} : periodDatesFor(parsed.payDate)),
    });
  });

/**
 * Run the tie-outs for a period against live Zenople.
 *
 * Results are persisted so the board can show the last run without re-pulling —
 * the vendor limits are 60 requests a minute and this is two calls per run, so
 * a page that re-ran on every render would be antisocial. Pass `?refresh=1` to
 * force a new pull.
 */
payrollRunRouter.get("/payroll-run/periods/:payDate/tie-outs", requireAuth,
  requireTile("payroll_process"), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    const period = await ensurePeriod(payDate, false);
    const refresh = String(req.query.refresh ?? "") === "1";

    if (!refresh) {
      const cached = await db.select().from(schema.payrollTieOutsTable)
        .where(eq(schema.payrollTieOutsTable.periodId, period.id));
      if (cached.length) {
        res.json({ period: period.label, ranAt: cached[0]!.ranAt, fromCache: true,
                   results: cached });
        return;
      }
    }

    if (!zenopleConfigured()) {
      // Say so plainly. "No results" and "not wired up" must not look alike.
      res.status(503).json({ error: "Zenople is not configured on this server" });
      return;
    }

    let pulled;
    try {
      pulled = await pullPeriod(payDate);
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "Zenople pull failed" });
      return;
    }

    // People who are genuinely non-billable — carried on the customer roster so
    // a known exception stops alarming without hiding a new one.
    const nonBillable = new Set<number>();
    const results = runTieOuts(pulled, nonBillable);

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(schema.payrollTieOutsTable)
        .where(eq(schema.payrollTieOutsTable.periodId, period.id));
      await tx.insert(schema.payrollTieOutsTable).values(
        results.map((r) => ({
          periodId: period.id, tieOut: r.tieOut, status: r.status, scope: r.scope,
          expected: r.expected, actual: r.actual, variance: r.variance,
          detail: JSON.stringify(r.detail), ranAt: now,
        })),
      );
    });

    res.json({
      period: period.label,
      accountingPeriod: pulled.accountingPeriod,
      ranAt: now,
      fromCache: false,
      counts: { items: pulled.items.length, deductions: pulled.deductions.length,
                customers: rosterFrom(pulled).length },
      results,
    });
  });
