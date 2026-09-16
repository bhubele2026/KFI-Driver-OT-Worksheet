import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { requireTile, type AuthedRequest } from "../lib/entraAuth.js";
import { isValidPayDate, periodDatesFor } from "../lib/payrollPeriod.js";
import { ensurePayrollPeriod } from "../lib/payrollPeriodStore.js";
import { ASK_LABEL, type Ask } from "../lib/housingNotes.js";

/**
 * Housing & Transport Notes — the payroll side of the two-app record.
 *
 * Brad, 2026-09-16: *"This then shows up on the payroll side in their own tile
 * where they now have a task to update for the payroll."* Housing files it;
 * this board works it and ticks it off, and that tick is the only thing this
 * app writes on the row.
 */
export const housingNotesRouter: IRouter = Router();

const TILE = "payroll_housing_notes";

function badPayDate(payDate: string, res: Response): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
    return true;
  }
  if (!isValidPayDate(payDate)) {
    res.status(400).json({
      error: "not a pay date — regular periods pay Friday (or the Thursday before a Friday holiday)",
    });
    return true;
  }
  return false;
}

/** The notes for a period, each with the pay rate this app can speak to. */
housingNotesRouter.get("/payroll-run/periods/:payDate/housing-notes", requireAuth,
  requireTile(TILE), async (req: Request, res: Response) => {
    const payDate = String(req.params.payDate);
    if (badPayDate(payDate, res)) return;
    const period = await ensurePayrollPeriod(payDate, false);

    const rows = await db.select().from(schema.housingNotesTable)
      .where(eq(schema.housingNotesTable.periodId, period.id))
      .orderBy(asc(schema.housingNotesTable.personName),
               asc(schema.housingNotesTable.noteKey));

    /**
     * ⚠️ THE RATE IS THE ONE FACT HOUSING DELIBERATELY DOES NOT HOLD (Brad's
     * call, 2026-09-16) — so it is added here, on the side that already has it.
     *
     * ⚠️ AND IT ONLY EXISTS FOR DRIVERS. `driver_payroll_profiles` is keyed on
     * kfi_id and a driver only gets a row if someone wants them in the Zenople
     * export, so a housed non-driver has none. That cell says "no rate on file
     * here" rather than a dash or a zero: a missing number has to say why, or
     * it reads as $0.00 an hour.
     *
     * No live Zenople pull on this board on purpose — the token endpoint allows
     * 20 requests an hour and a board that can exhaust it is a board that takes
     * the rest of the tile down with it.
     */
    const personIds = [...new Set(rows.map((r) => r.personId))];
    const profiles = personIds.length === 0 ? [] : await db.select({
      personId: schema.driverPayrollProfilesTable.personId,
      rtPayRate: schema.driverPayrollProfilesTable.rtPayRate,
      driverRtPayRate: schema.driverPayrollProfilesTable.driverRtPayRate,
    }).from(schema.driverPayrollProfilesTable)
      .where(inArray(schema.driverPayrollProfilesTable.personId, personIds));
    const rateFor = (personId: number) => {
      const p = profiles.find((x) => x.personId === personId);
      if (!p) return null;
      return { rtPayRate: p.rtPayRate, driverRtPayRate: p.driverRtPayRate };
    };

    /**
     * When Housing last called at all — across every period, not just this one.
     * ⚠️ "Nothing filed this week" and "Housing has not reached us since the
     * feature shipped" look identical on a board without this, and only one of
     * them is a problem. null means it has never called.
     */
    const [seen] = await db.select({
      at: sql<string | null>`max(${schema.housingNotesTable.updatedAt})`,
    }).from(schema.housingNotesTable);

    const live = rows.filter((r) => r.voidedAt === null);
    res.json({
      period: { ...period, ...periodDatesFor(period.payDate) },
      notes: rows.map((r) => ({
        ...r,
        askLabel: ASK_LABEL[r.ask as Ask] ?? r.ask,
        rate: rateFor(r.personId),
      })),
      housingLastFiledAt: seen?.at ?? null,
      counts: {
        notes: live.length,
        handled: live.filter((r) => r.handledAt !== null).length,
        waiting: live.filter((r) => r.handledAt === null).length,
        retracted: rows.filter((r) => r.voidedAt !== null).length,
      },
    });
  });

/**
 * Tick one note handled, or un-tick it.
 *
 * ⚠️ NARROW ON PURPOSE — these three columns and nothing else. Every fact on
 * the row belongs to Housing and arrives over the bridge; letting this board
 * write one would put two sources of truth back in conflict, which is the
 * mistake the Changes board's PATCH was written to avoid.
 *
 * ⚠️ UN-TICKING IS ALLOWED. A mis-click has to be correctable, and both presses
 * land on the append-only trail, so the history says what actually happened
 * rather than only what is true now.
 */
housingNotesRouter.post("/payroll-run/periods/:payDate/housing-notes/:noteKey/handled",
  requireAuth, requireTile(TILE), async (req: Request, res: Response) => {
    const a = req as AuthedRequest;
    const payDate = String(req.params.payDate);
    const noteKey = String(req.params.noteKey);
    const b = (req.body ?? {}) as { handled?: unknown; note?: unknown };
    if (typeof b.handled !== "boolean") {
      res.status(400).json({ error: "handled must be true or false" });
      return;
    }
    if (badPayDate(payDate, res)) return;
    const period = await ensurePayrollPeriod(payDate, false);

    const who = a.user?.email ?? a.authEmail ?? null;
    const handledNote = typeof b.note === "string" && b.note.trim() !== ""
      ? b.note.trim() : null;
    const patch = b.handled
      ? { handledAt: new Date(), handledBy: who, handledNote, updatedAt: new Date() }
      : { handledAt: null, handledBy: null, handledNote: null, updatedAt: new Date() };

    const updated = await db.update(schema.housingNotesTable).set(patch)
      .where(and(eq(schema.housingNotesTable.periodId, period.id),
                 eq(schema.housingNotesTable.noteKey, noteKey)))
      .returning();
    if (!updated[0]) {
      res.status(404).json({ error: "no such note for this period" });
      return;
    }

    await db.insert(schema.payrollStepAuditTable).values({
      periodId: period.id,
      stepKey: `housing-note:${noteKey}`,
      status: b.handled ? "handled" : "unhandled",
      note: handledNote,
      actorUserId: a.user?.id ?? null,
      actorEmail: who,
    });

    res.json({ ok: true, note: updated[0] });
  });

/**
 * The table may not exist yet on a database this build has not pushed to. Say
 * so in words rather than letting a bare 500 read as "the board is broken".
 * Same shape as the guard on payrollRun and the machine bridge.
 */
housingNotesRouter.use((
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) { next(err); return; }
  const code = typeof err === "object" && err !== null
    ? (err as { code?: unknown }).code : undefined;
  if (code === "42P01") {
    res.status(503).json({
      error: "The housing notes table has not been created in this database yet.",
      code: "payroll_schema_missing",
    });
    return;
  }
  next(err);
});
