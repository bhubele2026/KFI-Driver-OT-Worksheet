import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { requireTile, type AuthedRequest } from "../lib/entraAuth.js";
import { PAYROLL_CHECKLIST, OFF_CYCLE_STEP_KEYS } from "../lib/payrollChecklist.js";
import {
  isValidPayDate, parsePeriodLabel, payDateFor, payDates, periodDatesFor,
} from "../lib/payrollPeriod.js";
import { summarizeChangeActions } from "../lib/payrollChangeSummary.js";
import { addDays } from "../lib/time.js";
import { pullPeriod, runTieOuts, rosterFrom } from "../lib/zenoplePayroll.js";
import { pull } from "../lib/zenopleClient.js";
import { runBatchChecks, type RegisterRow } from "../lib/payrollBatchChecks.js";
import { aptmDeadline, APTM_OFFICES } from "../lib/payrollAptm.js";
import {
  expertPayDates, expertPayExportNote, runExpertPayChecks,
  EXPERT_PAY_BANK, EXPERT_PAY_ARTIFACTS,
} from "../lib/payrollExpertPay.js";
import {
  DISBURSEMENT_CHANNELS, CHANNEL_LABEL, CHANNELS_WITHOUT_BANK_FILE, channelFromFilename,
} from "../lib/payrollOffCycle.js";
import { zenopleConfigured } from "../lib/zenopleClient.js";
import { ensurePayrollPeriod } from "../lib/payrollPeriodStore.js";

export const payrollRunRouter: IRouter = Router();

const STATUSES = new Set(["pending", "in_progress", "done", "blocked", "skipped"]);
const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Refuse a date that is not a real pay day BEFORE it reaches the period
 * store. `ensurePayrollPeriod` is an unconditional upsert, so without this a
 * keyboard-scrubbed date input minted a junk `payroll_periods` row per
 * keystroke. Regular periods pay Friday — or the Thursday before, when that
 * Friday is a bank holiday. Off-cycle runs pay any weekday and skip the guard.
 */
function badPayDate(payDate: string, isOffCycle: boolean, res: Response): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
    return true;
  }
  if (!isOffCycle && !isValidPayDate(payDate)) {
    res.status(400).json({
      error: "not a pay date — regular periods pay Friday (or the Thursday before a Friday holiday); pass offCycle=1 for an off-cycle run",
    });
    return true;
  }
  return false;
}

/**
 * Make sure the step catalogue in the database matches the seed.
 *
 * Idempotent and safe to call on every request that needs steps: it inserts
 * what is missing and updates rows that have drifted, but never deletes. A step
 * that disappears from the seed is deactivated instead, because
 * `payroll_step_state` rows point at it and history should stay readable.
 *
 * ⚠️ EVERY WRITE HERE IS CONDITIONAL, and it did not used to be. The parent-id
 * pass ran 16 sequential UPDATEs on EVERY checklist load — sixteen round trips
 * per page view, forever, writing values that were already correct. The board is
 * the most-loaded page in the tile, so that was the whole cost of opening it.
 *
 * The steady state is now ONE select and nothing else.
 */
async function ensureSteps(): Promise<Map<string, number>> {
  const existing = await db
    .select({
      id: schema.payrollStepsTable.id, key: schema.payrollStepsTable.key,
      task: schema.payrollStepsTable.task, ordinal: schema.payrollStepsTable.ordinal,
      day: schema.payrollStepsTable.day, tile: schema.payrollStepsTable.tile,
      parentId: schema.payrollStepsTable.parentId,
      appliesOffCycle: schema.payrollStepsTable.appliesOffCycle,
      active: schema.payrollStepsTable.active,
    })
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

  // Only re-read when something was actually inserted.
  const rows = missing.length
    ? await db
        .select({
          id: schema.payrollStepsTable.id, key: schema.payrollStepsTable.key,
          task: schema.payrollStepsTable.task, ordinal: schema.payrollStepsTable.ordinal,
          day: schema.payrollStepsTable.day, tile: schema.payrollStepsTable.tile,
          parentId: schema.payrollStepsTable.parentId,
          appliesOffCycle: schema.payrollStepsTable.appliesOffCycle,
          active: schema.payrollStepsTable.active,
        })
        .from(schema.payrollStepsTable)
    : existing;
  const current = new Map(rows.map((r) => [r.key, r]));
  const idByKey = new Map(rows.map((r) => [r.key, r.id]));

  for (const s of PAYROLL_CHECKLIST) {
    const cur = current.get(s.key);
    if (!cur) continue;
    const wantParent = s.parent ? idByKey.get(s.parent) ?? null : null;
    const wantOffCycle = OFF_CYCLE_STEP_KEYS.has(s.key);
    // One comparison, one write only when it differs.
    if (
      cur.task === s.task && cur.ordinal === s.ordinal && cur.day === s.day
      && cur.tile === s.tile && cur.parentId === wantParent
      && cur.appliesOffCycle === wantOffCycle
      // ⚠️ A step that was deactivated and later returns to the seed must come
      // BACK. Without this it would stay inactive forever and silently vanish
      // from the checklist, which is the worst way for a step to disappear.
      && cur.active === true
    ) continue;

    await db.update(schema.payrollStepsTable)
      .set({
        task: s.task, ordinal: s.ordinal, day: s.day, tile: s.tile,
        parentId: wantParent, appliesOffCycle: wantOffCycle, active: true,
      })
      .where(eq(schema.payrollStepsTable.key, s.key));
  }

  const seedKeys = new Set(PAYROLL_CHECKLIST.map((s) => s.key));
  const stale = rows.filter((r) => !seedKeys.has(r.key)).map((r) => r.key);
  if (stale.length) {
    await db.update(schema.payrollStepsTable)
      .set({ active: false })
      .where(inArray(schema.payrollStepsTable.key, stale));
  }

  return idByKey;
}


/** Recent periods, newest first. */
payrollRunRouter.get("/payroll-run/periods", requireAuth, requireTile("payroll_process"),
  async (_req: Request, res: Response) => {
    const rows = await db.select().from(schema.payrollPeriodsTable)
      .orderBy(desc(schema.payrollPeriodsTable.payDate)).limit(60);
    res.json({ periods: rows, current: payDateFor(todayIso()) });
  });

/**
 * The dates a period may be run against — ARITHMETIC, not read from
 * payroll_periods, so junk rows minted before validation existed can never
 * surface in a picker. Friday, or the Thursday before a Friday holiday.
 * requireAuth only: every payroll tile carries the picker.
 */
payrollRunRouter.get("/payroll-run/pay-dates", requireAuth,
  (_req: Request, res: Response) => {
    res.json({ payDates: payDates(todayIso(), 12, 4), current: payDateFor(todayIso()) });
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
    if (badPayDate(payDate, isOffCycle, res)) return;

    await ensureSteps();
    const period = await ensurePayrollPeriod(payDate, isOffCycle);

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
    if (badPayDate(payDate, isOffCycle, res)) return;
    const period = await ensurePayrollPeriod(payDate, isOffCycle);
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
    if (badPayDate(payDate, false, res)) return;
    const from = await ensurePayrollPeriod(payDate, false);
    // The next REGULAR period is a week on — resolved through payDateFor so
    // a carry into Christmas week lands on the Thursday it actually pays.
    const to = await ensurePayrollPeriod(payDateFor(addDays(payDate, 7)), false);

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
    if (badPayDate(payDate, false, res)) return;
    const period = await ensurePayrollPeriod(payDate, false);
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

/** The action rows for a period, plus the decisions held back from them. */
payrollRunRouter.get("/payroll-run/periods/:payDate/changes", requireAuth,
  requireTile("payroll_changes"), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    const isOffCycle = String(req.query.offCycle ?? "") === "1";
    if (badPayDate(payDate, isOffCycle, res)) return;
    const period = await ensurePayrollPeriod(payDate, isOffCycle);
    const rows = await db.select().from(schema.payrollChangesTable)
      .where(eq(schema.payrollChangesTable.periodId, period.id))
      .orderBy(asc(schema.payrollChangesTable.customer), asc(schema.payrollChangesTable.employee));

    // A discussed intent is NOT an approval — decisions are kept off the action
    // list entirely rather than mixed in and hoped to be noticed.
    const actions = rows.filter((r) => !r.needsDecision);
    const decisions = rows.filter((r) => r.needsDecision);

    // Terse row labels — one cached AI pass per period. Never load-bearing:
    // a failure or a summary that flunks the number/negation check simply
    // leaves the row showing its full action text.
    const summaries = await summarizeChangeActions(
      actions.map((r) => ({
        rowKey: r.rowKey, changeType: r.changeType,
        employee: r.employee, action: r.action,
      })),
    );

    const verified = (r: typeof rows[number]): boolean => {
      const n = Math.max(1, r.peopleCount);
      const ok = (v: number) => v === -1 || v >= n;
      return ok(r.enteredZenople) && ok(r.verifiedTs) && ok(r.verifiedPas)
        && ok(r.documentationSaved);
    };

    res.json({
      period: { ...period, ...(period.isOffCycle ? {} : periodDatesFor(period.payDate)) },
      actions: actions.map((r) => ({ ...r, summary: summaries.get(r.rowKey) ?? null })),
      decisions,
      counts: {
        actions: actions.length,
        decisions: decisions.length,
        complete: actions.filter(verified).length,
        retro: actions.filter((r) => r.isRetro).length,
        paired: actions.filter((r) => r.pairedWithRowKey).length,
        newSinceLastSweep: actions.filter((r) => r.sweepState === "new").length,
        changedSinceLastSweep: actions.filter((r) => r.sweepState === "changed").length,
      },
    });
  });

/**
 * Update the fields a human owns on one action row.
 *
 * Deliberately narrow: the four verification counts, the notes, and whether it
 * still needs a decision. Everything else belongs to the sweep, and letting the
 * UI write facts would put the two sources of truth back in conflict.
 */
payrollRunRouter.patch("/payroll-run/periods/:payDate/changes/:rowKey", requireAuth,
  requireTile("payroll_changes"), async (req: Request, res: Response) => {
    const a = req as AuthedRequest;
    const payDate = String(req.params.payDate);
    const rowKey = String(req.params.rowKey);
    const b = (req.body ?? {}) as {
      enteredZenople?: number; verifiedTs?: number; verifiedPas?: number;
      documentationSaved?: number; notes?: string; needsDecision?: boolean;
    };

    const counts = ["enteredZenople", "verifiedTs", "verifiedPas", "documentationSaved"] as const;
    for (const f of counts) {
      const v = b[f];
      // -1 means n/a; anything else must be a non-negative whole number.
      if (v !== undefined && (!Number.isInteger(v) || v < -1)) {
        res.status(400).json({ error: `${f} must be -1 (n/a) or a count >= 0` });
        return;
      }
    }

    if (badPayDate(payDate, false, res)) return;
    const period = await ensurePayrollPeriod(payDate, false);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const f of counts) if (b[f] !== undefined) patch[f] = b[f];
    if (b.notes !== undefined) patch["notes"] = b.notes;
    if (b.needsDecision !== undefined) patch["needsDecision"] = b.needsDecision;

    if (Object.keys(patch).length === 1) {
      res.status(400).json({ error: "nothing to update" });
      return;
    }

    const updated = await db.update(schema.payrollChangesTable).set(patch)
      .where(and(eq(schema.payrollChangesTable.periodId, period.id),
                 eq(schema.payrollChangesTable.rowKey, rowKey)))
      .returning();
    if (!updated[0]) {
      res.status(404).json({ error: "no such row for this period" });
      return;
    }

    await db.insert(schema.payrollStepAuditTable).values({
      periodId: period.id,
      stepKey: `change:${rowKey}`,
      status: "updated",
      note: JSON.stringify(patch),
      actorUserId: a.user?.id ?? null,
      actorEmail: a.user?.email ?? a.authEmail ?? null,
    });

    res.json({ ok: true, row: updated[0] });
  });

/**
 * Toggle a row in or out of the PDF SELECTION — a press picks, it never runs.
 *
 * Brad's model, stated on the board: pick the rows first, then one button
 * runs the machine on exactly that selection. 'selected' is invisible to the
 * executor by construction — the wake daemon and the claim look only for
 * 'requested', which pdf-run below sets. A failed row presses back into the
 * selection for a re-run; a row already in flight or filed is left alone.
 */
payrollRunRouter.post("/payroll-run/periods/:payDate/changes/:rowKey/pdf-request",
  requireAuth, requireTile("payroll_changes"), async (req: Request, res: Response) => {
    const a = req as AuthedRequest;
    const payDate = String(req.params.payDate);
    const rowKey = String(req.params.rowKey);
    const isOffCycle = String(req.query.offCycle ?? "") === "1";
    if (badPayDate(payDate, isOffCycle, res)) return;
    const period = await ensurePayrollPeriod(payDate, isOffCycle);

    const existing = await db.select().from(schema.payrollChangesTable)
      .where(and(eq(schema.payrollChangesTable.periodId, period.id),
                 eq(schema.payrollChangesTable.rowKey, rowKey)))
      .limit(1);
    if (!existing[0]) {
      res.status(404).json({ error: "no such row for this period" });
      return;
    }

    const cur = existing[0].pdfStatus;
    if (cur === "requested" || cur === "filed") {
      // In flight, or already linked to its document — nothing to toggle.
      res.json({ ok: true, row: existing[0] });
      return;
    }

    const selecting = cur !== "selected";
    const now = new Date();
    const updated = await db.update(schema.payrollChangesTable).set(
      selecting
        ? {
            pdfStatus: "selected",
            pdfRequestedBy: a.user?.email ?? a.authEmail ?? null,
            pdfError: null,
            updatedAt: now,
          }
        : { pdfStatus: null, updatedAt: now },
    ).where(and(eq(schema.payrollChangesTable.periodId, period.id),
                eq(schema.payrollChangesTable.rowKey, rowKey)))
      .returning();

    await db.insert(schema.payrollStepAuditTable).values({
      periodId: period.id,
      stepKey: `change:${rowKey}`,
      status: selecting ? "pdf-selected" : "pdf-unselected",
      note: null,
      actorUserId: a.user?.id ?? null,
      actorEmail: a.user?.email ?? a.authEmail ?? null,
    });

    res.json({ ok: true, row: updated[0] });
  });

/**
 * Run the selection — the Create PDFs button. Moves every 'selected' row in
 * the period to 'requested'; the Mac daemon's long-poll releases within
 * seconds and the executor gives each row its own verdict.
 */
payrollRunRouter.post("/payroll-run/periods/:payDate/pdf-run",
  requireAuth, requireTile("payroll_changes"), async (req: Request, res: Response) => {
    const a = req as AuthedRequest;
    const payDate = String(req.params.payDate);
    const isOffCycle = String(req.query.offCycle ?? "") === "1";
    if (badPayDate(payDate, isOffCycle, res)) return;
    const period = await ensurePayrollPeriod(payDate, isOffCycle);

    const now = new Date();
    const updated = await db.update(schema.payrollChangesTable).set({
      pdfStatus: "requested",
      pdfRequestedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.payrollChangesTable.periodId, period.id),
      eq(schema.payrollChangesTable.pdfStatus, "selected"),
    )).returning({ rowKey: schema.payrollChangesTable.rowKey });

    if (updated.length > 0) {
      await db.insert(schema.payrollStepAuditTable).values({
        periodId: period.id,
        stepKey: "pdf-run",
        status: "pdf-requested",
        note: JSON.stringify({ queued: updated.length }),
        actorUserId: a.user?.id ?? null,
        actorEmail: a.user?.email ?? a.authEmail ?? null,
      });
    }

    res.json({ ok: true, queued: updated.length });
  });

/**
 * Wednesday's register checks, run against live Zenople.
 *
 * Unlike the tie-outs this is not persisted — it is a read of the register as
 * it stands right now, and a stale copy of "no live checks" would be worse than
 * no answer at all.
 */
payrollRunRouter.get("/payroll-run/periods/:payDate/batch-checks", requireAuth,
  requireTile("payroll_batch"), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    if (!zenopleConfigured()) {
      res.status(503).json({ error: "Zenople is not configured on this server" });
      return;
    }

    let rows: RegisterRow[];
    try {
      // The window filters on last-modified, so pull recent and select the
      // check date locally — the same rule the period pull follows.
      const pulled = await pull<RegisterRow>("PayrollData", { lookbackDays: 45 });
      rows = pulled.filter((r) => String(r.CheckDate ?? "").slice(0, 10) === payDate);
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "Zenople pull failed" });
      return;
    }

    if (rows.length === 0) {
      // Say which it is. "No payments yet" and "the pull failed" must not look
      // the same to someone deciding whether to close the batch.
      res.json({
        payDate, found: 0,
        checks: [{
          check: "register_present", status: "info",
          message: `no payments on the register for ${payDate} yet — the batch has not been run`,
          detail: [],
        }],
      });
      return;
    }

    res.json({ payDate, found: rows.length, checks: runBatchChecks(rows) });
  });

/** The APTM clock and gates. The tie-out needs figures a person supplies. */
payrollRunRouter.get("/payroll-run/aptm-status", requireAuth, requireTile("payroll_taxes"),
  (_req: Request, res: Response) => {
    const d = aptmDeadline();
    res.json({
      deadline: d,
      offices: APTM_OFFICES,
      checks: [{
        check: "deadline",
        status: d.state === "past" ? "fail" : d.state === "soon" ? "warn" : "info",
        message: d.state === "past"
          ? `past the ${d.deadlineCt} cutoff`
          : `${d.minutesRemaining} minutes until the ${d.deadlineCt} cutoff`,
        detail: [],
      }],
    });
  });

/**
 * Monday's per-customer intake board.
 *
 * ⚠️ COVERAGE IS UNEVEN AND THE BOARD SAYS SO. Zenople holds DAILY punch detail
 * for exactly one customer — Alamco, on TimeClockApp. Measured on AP
 * 2026-08-23: 168 date rows covering 12 people, one organization. Every other
 * customer's daily punches arrive as an emailed file, so for them this reports
 * what Zenople has at the WEEK level and says plainly that the punch compare
 * still needs the file.
 *
 * Reporting a green board for 27 customers whose punches nobody has looked at
 * would be worse than reporting nothing.
 */
payrollRunRouter.get("/payroll-run/periods/:payDate/hours-intake", requireAuth,
  requireTile("payroll_hours"), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    if (!zenopleConfigured()) {
      res.status(503).json({ error: "Zenople is not configured on this server" });
      return;
    }

    const { accountingPeriod } = periodDatesFor(payDate);
    let tx: Array<Record<string, unknown>>;
    let dated: Array<Record<string, unknown>>;
    try {
      [tx, dated] = await Promise.all([
        pull<Record<string, unknown>>("TransactionData", { lookbackDays: 30 }),
        pull<Record<string, unknown>>("TransactionItemDateData", { lookbackDays: 30 }),
      ]);
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "Zenople pull failed" });
      return;
    }

    const inPeriod = (r: Record<string, unknown>) =>
      String(r["AccountingPeriod"] ?? "").slice(0, 10) === accountingPeriod;
    const weekTx = tx.filter(inPeriod);
    const weekDated = dated.filter(inPeriod);

    // Which customers Zenople actually has daily detail for.
    const dailyByCustomer = new Map<string, Array<Record<string, unknown>>>();
    for (const d of weekDated) {
      const k = String(d["Organization"] ?? "");
      const arr = dailyByCustomer.get(k);
      if (arr) arr.push(d);
      else dailyByCustomer.set(k, [d]);
    }

    const byCustomer = new Map<string, {
      rows: number; people: Set<number>; rt: number; ot: number;
      timeSources: Set<string>; closed: number; open: number;
    }>();
    for (const t of weekTx) {
      const k = String(t["Organization"] ?? "(unknown)");
      const cur = byCustomer.get(k) ?? {
        rows: 0, people: new Set<number>(), rt: 0, ot: 0,
        timeSources: new Set<string>(), closed: 0, open: 0,
      };
      cur.rows++;
      if (typeof t["PersonId"] === "number") cur.people.add(t["PersonId"]);
      cur.rt += Number(t["RTPayHours"] ?? 0);
      cur.ot += Number(t["OTPayHours"] ?? 0);
      const src = String(t["TimeSource"] ?? "").trim();
      if (src) cur.timeSources.add(src);
      if (t["CloseDate"]) cur.closed++;
      else cur.open++;
      byCustomer.set(k, cur);
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const customers = [...byCustomer].sort((a, b) => a[0].localeCompare(b[0])).map(([name, v]) => {
      const daily = dailyByCustomer.get(name) ?? [];
      // Daily hours per person-day, for the 13-hour guard.
      const perDay = new Map<string, number>();
      for (const d of daily) {
        const key = `${String(d["PersonId"])}|${String(d["WorkDate"] ?? "").slice(0, 10)}`;
        perDay.set(key, (perDay.get(key) ?? 0) + Number(d["DailyPayUnit"] ?? 0));
      }
      const longShifts = [...perDay]
        .filter(([, h]) => h > 13)
        .map(([k, h]) => {
          const [personId, workDate] = k.split("|");
          const row = daily.find((d) => String(d["PersonId"]) === personId);
          return { personId: Number(personId), person: row?.["Person"] ?? null,
                   workDate, hours: round2(h) };
        });

      return {
        customer: name,
        people: v.people.size,
        rtHours: round2(v.rt),
        otHours: round2(v.ot),
        timeSources: [...v.timeSources],
        batchesClosed: v.closed,
        batchesOpen: v.open,
        // The honest part.
        hasDailyDetailInZenople: daily.length > 0,
        dailyPersonDays: perDay.size,
        longShifts,
        punchCompare: daily.length > 0
          ? (longShifts.length ? "exceptions" : "clean")
          : "needs the customer's punch file",
      };
    });

    res.json({
      payDate, accountingPeriod,
      customers,
      coverage: {
        customersWithZenopleDailyDetail: customers.filter((c) => c.hasDailyDetailInZenople).length,
        customersTotal: customers.length,
        note:
          "Zenople holds daily punch detail only for customers on TimeClockApp. " +
          "Everyone else's punches arrive as an emailed file and still have to be compared by hand.",
      },
    });
  });

/**
 * The fringe reconciliation, live.
 *
 * Both sides come from Zenople: the earnings from TransactionItemData and the
 * offsetting deductions from DeductionData. This is the balance that has to be
 * exact, so it reports per person as well as in total — a difference of 69.23
 * means one person, and naming them is the whole job.
 */
payrollRunRouter.get("/payroll-run/periods/:payDate/fringe", requireAuth,
  requireTile("payroll_fringe"), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    if (!zenopleConfigured()) {
      res.status(503).json({ error: "Zenople is not configured on this server" });
      return;
    }

    const { accountingPeriod } = periodDatesFor(payDate);
    let items: Array<Record<string, unknown>>;
    let deductions: Array<Record<string, unknown>>;
    try {
      [items, deductions] = await Promise.all([
        pull<Record<string, unknown>>("TransactionItemData", { lookbackDays: 30 }),
        pull<Record<string, unknown>>("DeductionData", { lookbackDays: 30 }),
      ]);
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : "Zenople pull failed" });
      return;
    }

    const inPeriod = (r: Record<string, unknown>) =>
      String(r["AccountingPeriod"] ?? "").slice(0, 10) === accountingPeriod;

    const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
    const money = (c: number) => (c / 100).toFixed(2);

    /** One pairing of an earning code with the deduction that offsets it. */
    const pair = (earnCode: string, dedCode: string) => {
      const earnRows = items.filter(
        (r) => inPeriod(r) && r["TransactionCode"] === earnCode);

      const earnByPerson = new Map<number, { name: string; cents: number }>();
      for (const r of earnRows) {
        const id = Number(r["PersonId"] ?? -1);
        const cur = earnByPerson.get(id) ?? { name: String(r["Person"] ?? id), cents: 0 };
        cur.cents += cents(r["ItemPay"]);
        earnByPerson.set(id, cur);
      }

      // ⚠️ Adjustment, never Deduction — and deduped on PaymentAdjustmentId,
      // because the endpoint repeats rows and this has to be exact.
      const seen = new Set<number>();
      const dedByPerson = new Map<number, { name: string; cents: number }>();
      for (const r of deductions) {
        if (!inPeriod(r) || r["TransactionCode"] !== dedCode) continue;
        const adjId = r["PaymentAdjustmentId"];
        if (typeof adjId === "number") {
          if (seen.has(adjId)) continue;
          seen.add(adjId);
        }
        const id = Number(r["PersonId"] ?? -1);
        const cur = dedByPerson.get(id) ?? { name: String(r["Name"] ?? id), cents: 0 };
        cur.cents += cents(r["Adjustment"]);
        dedByPerson.set(id, cur);
      }

      const earnTotal = [...earnByPerson.values()].reduce((s, v) => s + v.cents, 0);
      const dedTotal = [...dedByPerson.values()].reduce((s, v) => s + v.cents, 0);

      const everyone = new Set([...earnByPerson.keys(), ...dedByPerson.keys()]);
      const mismatches: unknown[] = [];
      for (const id of everyone) {
        const e = earnByPerson.get(id);
        const d = dedByPerson.get(id);
        const diff = (e?.cents ?? 0) - (d?.cents ?? 0);
        if (diff !== 0) {
          mismatches.push({
            personId: id, person: e?.name ?? d?.name ?? String(id),
            earning: money(e?.cents ?? 0), deduction: money(d?.cents ?? 0),
            variance: `${diff > 0 ? "+" : ""}${money(diff)}`,
            hint: diff > 0 ? "earning with no matching deduction" : "deduction with no matching earning",
          });
        }
      }

      const diff = earnTotal - dedTotal;
      return {
        earnCode, dedCode,
        earnings: money(earnTotal), deductions: money(dedTotal),
        variance: `${diff > 0 ? "+" : ""}${money(diff)}`,
        balanced: diff === 0,
        earningPeople: earnByPerson.size,
        deductionPeople: dedByPerson.size,
        mismatches: mismatches.slice(0, 40),
        sign: diff === 0 ? null
          : diff > 0 ? "positive — missing deductions" : "negative — missing earnings",
      };
    };

    res.json({
      payDate, accountingPeriod,
      current: pair("Housing Benefit Supplemental", "Housing Benefit Offset Supplemental"),
      retro: pair("Retro Housing Benefit Sup", "Retro Housing Benefits Offset Supplemental"),
    });
  });

/**
 * Expert Pay — the dates and the gates.
 *
 * ⚠️ No file, no rows, no SSNs. The CSV stays on the Mac; this returns the two
 * dates a person has to type and the checks they have to satisfy.
 */
payrollRunRouter.get("/payroll-run/periods/:payDate/expert-pay", requireAuth,
  requireTile("payroll_expert_pay"), (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    res.json({
      ...expertPayDates(payDate),
      exportNote: expertPayExportNote(payDate),
      bank: EXPERT_PAY_BANK,
      artifacts: EXPERT_PAY_ARTIFACTS,
    });
  });

/**
 * Check what a person typed into Expert Pay before they submit.
 *
 * Totals are compared here rather than in the browser so the fee tolerance is
 * one rule in one place.
 */
payrollRunRouter.post("/payroll-run/periods/:payDate/expert-pay/verify", requireAuth,
  requireTile("payroll_expert_pay"), (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    const b = (req.body ?? {}) as {
      enteredEffective?: string; enteredWithholding?: string; bankAccount?: string;
      csvTotal?: number; systemTotal?: number;
      format?: {
        openedWithoutConverting: boolean; columnCZeroDecimals: boolean;
        ssnLeadingZerosIntact: boolean; savedAfterFormatting: boolean;
      };
    };
    res.json({ checks: runExpertPayChecks({ payDate, ...b }) });
  });

/** Off-cycle runs recorded for a date, with their artifact checks. */
payrollRunRouter.get("/payroll-run/off-cycle", requireAuth, requireTile("payroll_off_cycle"),
  async (_req: Request, res: Response) => {
    const rows = await db.select().from(schema.payrollPeriodsTable)
      .where(eq(schema.payrollPeriodsTable.isOffCycle, true))
      .orderBy(desc(schema.payrollPeriodsTable.payDate)).limit(40);

    // Artifacts the bridge has inventoried for each, so the quad can be judged.
    const ids = rows.map((r) => r.id);
    const artifacts = ids.length
      ? await db.select().from(schema.payrollArtifactsTable)
          .where(inArray(schema.payrollArtifactsTable.periodId, ids))
      : [];

    const byPeriod = new Map<number, typeof artifacts>();
    for (const a of artifacts) {
      const arr = byPeriod.get(a.periodId);
      if (arr) arr.push(a);
      else byPeriod.set(a.periodId, [a]);
    }

    res.json({
      channels: DISBURSEMENT_CHANNELS.map((c) => ({ key: c, label: CHANNEL_LABEL[c],
        producesBankFile: !CHANNELS_WITHOUT_BANK_FILE.has(c) })),
      runs: rows.map((p) => {
        const mine = byPeriod.get(p.id) ?? [];
        const kinds = new Set(mine.map((a) => a.artifactKind));
        // The channel is inferred from filenames for historical runs; new ones
        // will carry it as a field.
        const inferred = mine
          .map((a) => channelFromFilename(a.fileName))
          .find((c) => c !== null) ?? null;
        return {
          periodId: p.id, payDate: p.payDate, label: p.label,
          files: mine.length,
          inferredChannel: inferred,
          hasApproval: kinds.has("approval_email") || kinds.has("documentation"),
          hasTransactionBatchReport: kinds.has("transaction_batch_report"),
          hasPaymentBatchReport: kinds.has("payment_batch_report"),
          hasBankFile: kinds.has("bank_feed"),
          isAdvance: kinds.has("advance"),
          hasVoidOrCorrection: kinds.has("void_or_correction"),
        };
      }),
    });
  });

/**
 * Turn the one failure this tile is genuinely likely to hit into a sentence.
 *
 * ⚠️ The payroll tables are created by `drizzle-kit push`, which is a separate,
 * deliberate step that a person has to run. Until it happens EVERY endpoint here
 * throws Postgres 42P01 (`undefined_table`), and with no error middleware in
 * this app that reaches the browser as a bare 500. "checklist 500" tells nobody
 * anything; "the payroll tables have not been created yet" tells them exactly
 * what to do.
 *
 * Registered on the payroll router only, so it cannot change how the rest of
 * the app reports errors.
 */
const PG_UNDEFINED_TABLE = "42P01";

function pgCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

payrollRunRouter.use((
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) { next(err); return; }

  if (pgCode(err) === PG_UNDEFINED_TABLE) {
    res.status(503).json({
      error:
        "The payroll tables have not been created in this database yet. " +
        "Run the schema push before using the payroll tiles.",
      code: "payroll_schema_missing",
    });
    return;
  }
  next(err);
});
