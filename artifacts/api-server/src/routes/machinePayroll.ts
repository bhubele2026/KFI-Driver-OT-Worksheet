import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { requirePulseKey } from "./pulse.js";
import {
  clampWaitMs, pdfResultPatch, validatePdfResult, type PdfResult,
} from "../lib/payrollPdfQueue.js";
import {
  normalizeChangeType, routeForChangeType, seedFromCategory,
} from "../lib/payrollChangeTypes.js";
import {
  mergeSweep, sweepIsSafeToApply, rowKeyFor,
  type SweptRow, type StoredRow,
} from "../lib/payrollChangeMerge.js";
import { ensurePayrollPeriod } from "../lib/payrollPeriodStore.js";
import { isValidPayDate } from "../lib/payrollPeriod.js";

/**
 * The local bridge's way in.
 *
 * ⭐ WHY A BRIDGE AT ALL. The app cannot read payroll@kfistaffing.com and cannot
 * see the SharePoint folder: the mailbox needs delegated Graph permission this
 * tenant will not grant a daemon, and the PD folder lives in OneDrive on a Mac.
 * So the extraction runs THERE and pushes here. The app is the surface, not the
 * scraper.
 *
 * ⚠️ ONE PATH ON PURPOSE. Easy Auth is configured with `/api/machine/payroll`
 * in `excludedPaths`, and a path it does not name gets a login redirect that a
 * script cannot follow — the symptom is a `www-authenticate: Bearer` header and
 * a confusing 401. Adding `/api/machine/payroll/changes` would need another
 * exclusion, and that ARM update is a step a person has to run. Everything the
 * bridge sends therefore arrives on this one endpoint, keyed by `kind` in the
 * body.
 *
 * Authenticated by the shared pulse key, not a session — a script has no cookie.
 */
export const machinePayrollRouter: IRouter = Router();

type Body = {
  payDate?: string;
  isOffCycle?: boolean;
  kind?: "changes" | "artifacts" | "ping" | "pdf-claim" | "pdf-result" | "pdf-wait";
  /** True when more chunks follow; the empty-sweep guard is skipped until the
   *  last one, or a chunked push would look like an empty sweep. */
  more?: boolean;
  /** pdf-claim: just say how many are pending — the cheap question, asked
   *  before anything heavier is started. */
  countOnly?: boolean;
  /** pdf-wait: how long to hold the long-poll (clamped to 5–230s). */
  timeoutSeconds?: number;
  /** pdf-result: what the executor did with each claimed request. */
  results?: unknown[];
  changes?: Array<Partial<SweptRow> & { changeType: string; action: string }>;
  sources?: Array<{
    messageId: string; conversationId?: string; subject?: string; sender?: string;
    receivedAt?: string; categories?: string[]; attachmentNames?: string[];
    drivesRowKeys?: string[];
  }>;
  artifacts?: Array<{
    relPath: string; subfolder?: string; fileName: string; ext?: string;
    sizeBytes?: number; modifiedAt?: string; artifactKind?: string; sensitive?: boolean;
  }>;
};


machinePayrollRouter.post("/machine/payroll", requirePulseKey,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Body;

    // ── the Create-PDF queue ─────────────────────────────────────────────
    // A processor presses "Create PDF" on a change row; the Mac-side executor
    // (the only thing that can read payroll@ and the SharePoint folder) claims
    // the requests here, files each email as a PDF, and reports back. These
    // two kinds span periods, so they carry no payDate — and they ride this
    // same endpoint because of the one-excluded-path rule above.
    if (body.kind === "pdf-wait") {
      // Long-poll: hold the response until a Create-PDF press appears, so the
      // Mac-side daemon starts filing within seconds of the button instead of
      // on a cycle. Server-side it is a 3s existence check on an indexed
      // column — no NOTIFY plumbing to go wrong. The hold is clamped under
      // the ingress timeout so the daemon always gets a clean answer, never
      // a 504 it would have to treat as a failure.
      const deadline = Date.now() + clampWaitMs(body.timeoutSeconds);
      for (;;) {
        const [c] = await db.select({ n: sql<number>`count(*)::int` })
          .from(schema.payrollChangesTable)
          .where(eq(schema.payrollChangesTable.pdfStatus, "requested"));
        const n = c?.n ?? 0;
        if (n > 0 || Date.now() >= deadline) {
          res.json({ ok: true, pending: n });
          return;
        }
        await new Promise((r) => setTimeout(r, 3_000));
        // The daemon gave up or reconnected — stop holding a dead socket.
        if (res.destroyed || res.writableEnded) return;
      }
    }

    if (body.kind === "pdf-claim") {
      const t = schema.payrollChangesTable;
      const p = schema.payrollPeriodsTable;
      const rows = await db.select({
        periodId: t.periodId, rowKey: t.rowKey,
        payDate: p.payDate, isOffCycle: p.isOffCycle, periodLabel: p.label,
        customer: t.customer, employee: t.employee,
        changeType: t.changeType, action: t.action, category: t.category,
        weekEnding: t.weekEnding, effectiveDate: t.effectiveDate,
        conversationId: t.conversationId, sourceMessageId: t.sourceMessageId,
        sourceRef: t.sourceRef, sourceReceivedAt: t.sourceReceivedAt,
        requestedBy: t.requestedBy, fileNaming: t.fileNaming,
        pdfRequestedBy: t.pdfRequestedBy, pdfRequestedAt: t.pdfRequestedAt,
      }).from(t).innerJoin(p, eq(t.periodId, p.id))
        .where(eq(t.pdfStatus, "requested"))
        .orderBy(asc(t.pdfRequestedAt));
      if (body.countOnly === true) {
        res.json({ ok: true, pending: rows.length });
        return;
      }
      // Attach the sweep's message record where one names this row — subject,
      // sender and attachment names make finding the mail exact instead of a
      // search. Claiming does NOT flip the status: a crashed executor must
      // leave the request claimable on the next cycle, and the only writer of
      // "filed" is a verified file on disk.
      const periodIds = [...new Set(rows.map((r) => r.periodId))];
      const sources = periodIds.length === 0 ? [] :
        await db.select().from(schema.payrollChangeSourcesTable)
          .where(inArray(schema.payrollChangeSourcesTable.periodId, periodIds));
      const sourceFor = (r: (typeof rows)[number]) =>
        sources.find((s) => s.periodId === r.periodId
          && (s.drivesRowKeys?.includes(r.rowKey) ?? false))
        ?? sources.find((s) => s.periodId === r.periodId
          && r.conversationId != null && s.conversationId === r.conversationId)
        ?? null;
      res.json({
        ok: true,
        pending: rows.length,
        requests: rows.map((r) => {
          const s = sourceFor(r);
          return {
            ...r,
            source: s === null ? null : {
              messageId: s.messageId, conversationId: s.conversationId,
              subject: s.subject, sender: s.sender, receivedAt: s.receivedAt,
              attachmentNames: s.attachmentNames,
            },
          };
        }),
      });
      return;
    }

    if (body.kind === "pdf-result") {
      const raw = Array.isArray(body.results) ? body.results : [];
      if (raw.length === 0) {
        res.status(400).json({ error: "results is required for kind pdf-result" });
        return;
      }
      const results: PdfResult[] = [];
      for (const r of raw) {
        const v = validatePdfResult(r);
        if (!v.ok) {
          res.status(400).json({ error: v.error });
          return;
        }
        results.push(v.result);
      }
      const now = new Date();
      let updated = 0;
      const missing: string[] = [];
      for (const r of results) {
        const hit = await db.update(schema.payrollChangesTable)
          .set(pdfResultPatch(r, now))
          .where(and(
            eq(schema.payrollChangesTable.periodId, r.periodId),
            eq(schema.payrollChangesTable.rowKey, r.rowKey),
            // Only rows that entered the lifecycle — a mistyped key must not
            // decorate an unrelated row with a PDF it never asked for.
            isNotNull(schema.payrollChangesTable.pdfStatus),
          ))
          .returning({ rowKey: schema.payrollChangesTable.rowKey });
        if (!hit[0]) {
          missing.push(r.rowKey);
          continue;
        }
        updated++;
        await db.insert(schema.payrollStepAuditTable).values({
          periodId: r.periodId,
          stepKey: `change:${r.rowKey}`,
          status: r.outcome === "filed" ? "pdf-filed" : "pdf-failed",
          note: JSON.stringify({
            by: "payroll-pdf executor",
            webUrl: r.webUrl ?? null, fileName: r.fileName ?? null,
            error: r.error ?? null,
          }),
          actorUserId: null,
          actorEmail: null,
        });
      }
      res.json({ ok: true, updated, missing });
      return;
    }

    const payDate = body.payDate ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    if (body.kind === "ping") {
      res.json({ ok: true, pong: true });
      return;
    }

    // The bridge obeys the same law as the humans: a regular period pays
    // Friday, or the Thursday before a Friday holiday. Off-cycle escapes.
    if (body.isOffCycle !== true && !isValidPayDate(payDate)) {
      res.status(400).json({
        error: "not a pay date — regular periods pay Friday (or the Thursday before a Friday holiday); set isOffCycle for an off-cycle run",
      });
      return;
    }
    const period = await ensurePayrollPeriod(payDate, body.isOffCycle === true);
    const out: Record<string, unknown> = { period: period.label, periodId: period.id };

    if (body.artifacts?.length) {
      // ⚠️ Never store the CONTENTS of a sensitive file. The Expert Pay CSV
      // carries unmasked SSNs; it is recorded by name so a tile can say it
      // exists, and nothing more.
      for (const a of body.artifacts) {
        await db.insert(schema.payrollArtifactsTable).values({
          periodId: period.id, relPath: a.relPath, subfolder: a.subfolder ?? null,
          fileName: a.fileName, ext: a.ext ?? null, sizeBytes: a.sizeBytes ?? null,
          modifiedAt: a.modifiedAt ? new Date(a.modifiedAt) : null,
          artifactKind: a.artifactKind ?? null,
          sensitive: a.sensitive === true,
        }).onConflictDoUpdate({
          target: [schema.payrollArtifactsTable.periodId, schema.payrollArtifactsTable.relPath],
          set: {
            sizeBytes: a.sizeBytes ?? null,
            modifiedAt: a.modifiedAt ? new Date(a.modifiedAt) : null,
            artifactKind: a.artifactKind ?? null,
            seenAt: new Date(),
          },
        });
      }
      out["artifacts"] = body.artifacts.length;
    }

    if (body.changes) {
      const swept: SweptRow[] = body.changes.map((c) => {
        const changeType = normalizeChangeType(c.changeType);
        const rowKey = c.rowKey ?? rowKeyFor({
          conversationId: c.conversationId ?? null,
          employee: c.employee ?? null,
          changeType: c.changeType,
          weekEnding: c.weekEnding ?? null,
        });
        // Route: the sender's explicit value wins; otherwise the type's default
        // (Tiana's own routing, learned); otherwise the Outlook category as a
        // prior. "Other" with no category stays null and shows as needing a
        // route rather than being guessed into a stage.
        const route = c.route
          ?? routeForChangeType(changeType)
          ?? seedFromCategory(c.category)?.route
          ?? null;
        // JSON has no Date: the bridge sends sourceReceivedAt as an ISO
        // string, and drizzle's timestamp column requires a real Date. The
        // sources block below always converted; the rows never did, which
        // surfaced the moment a sweep actually supplied the field. undefined
        // stays undefined — the merge reads that as "not supplied".
        const rawReceived = c.sourceReceivedAt as unknown;
        const sourceReceivedAt = rawReceived == null
          ? (rawReceived as null | undefined)
          : new Date(rawReceived as string | Date);
        return {
          ...c, rowKey, changeType, route,
          changeTypeRaw: c.changeTypeRaw ?? c.changeType,
          action: c.action,
          sourceReceivedAt: sourceReceivedAt instanceof Date
            && Number.isNaN(sourceReceivedAt.getTime()) ? null : sourceReceivedAt,
        } as SweptRow;
      });

      const existing = await db.select().from(schema.payrollChangesTable)
        .where(eq(schema.payrollChangesTable.periodId, period.id));

      // ⚠️ Skip the guard mid-chunk: a chunked push legitimately sends a small
      // or empty batch, and refusing it would break the very thing the guard
      // exists to protect.
      if (body.more !== true) {
        const safe = sweepIsSafeToApply(swept.length, existing.length);
        if (!safe.ok) {
          res.status(409).json({ error: safe.reason, applied: false });
          return;
        }
      }

      const stored: StoredRow[] = existing.map((r) => ({
        rowKey: r.rowKey, customer: r.customer, employee: r.employee,
        peopleCount: r.peopleCount, route: r.route,
        changeType: r.changeType as SweptRow["changeType"],
        changeTypeRaw: r.changeTypeRaw,
        amount: r.amount == null ? null : Number(r.amount),
        hours: r.hours == null ? null : Number(r.hours),
        weekEnding: r.weekEnding, effectiveDate: r.effectiveDate,
        isRetro: r.isRetro, action: r.action, supersedes: r.supersedes,
        pairedWithRowKey: r.pairedWithRowKey, requestedBy: r.requestedBy,
        approvedBy: r.approvedBy, category: r.category,
        conversationId: r.conversationId, sourceMessageId: r.sourceMessageId,
        sourceRef: r.sourceRef, sourceReceivedAt: r.sourceReceivedAt,
        needsDecision: r.needsDecision, decisionQuestion: r.decisionQuestion,
        decisionOwner: r.decisionOwner,
        enteredZenople: r.enteredZenople, verifiedTs: r.verifiedTs,
        verifiedPas: r.verifiedPas, documentationSaved: r.documentationSaved,
        notes: r.notes,
      }));

      const merged = mergeSweep(swept, stored);
      const now = new Date();
      for (const row of merged.rows) {
        await db.insert(schema.payrollChangesTable).values({
          periodId: period.id, rowKey: row.rowKey,
          customer: row.customer ?? null, employee: row.employee ?? null,
          peopleCount: row.peopleCount ?? 1, route: row.route ?? null,
          changeType: row.changeType, changeTypeRaw: row.changeTypeRaw ?? null,
          amount: row.amount == null ? null : String(row.amount),
          hours: row.hours == null ? null : String(row.hours),
          weekEnding: row.weekEnding ?? null, effectiveDate: row.effectiveDate ?? null,
          isRetro: row.isRetro ?? false, action: row.action,
          supersedes: row.supersedes ?? null,
          pairedWithRowKey: row.pairedWithRowKey ?? null,
          requestedBy: row.requestedBy ?? null, approvedBy: row.approvedBy ?? null,
          category: row.category ?? null, conversationId: row.conversationId ?? null,
          sourceMessageId: row.sourceMessageId ?? null,
          sourceRef: row.sourceRef ?? null,
          sourceReceivedAt: row.sourceReceivedAt ?? null,
          needsDecision: row.needsDecision ?? false,
          decisionQuestion: row.decisionQuestion ?? null,
          decisionOwner: row.decisionOwner ?? null,
          enteredZenople: row.enteredZenople, verifiedTs: row.verifiedTs,
          verifiedPas: row.verifiedPas, documentationSaved: row.documentationSaved,
          notes: row.notes ?? null,
          sweepState: row.sweepState ?? "unchanged", lastSweptAt: now,
        }).onConflictDoUpdate({
          target: [schema.payrollChangesTable.periodId, schema.payrollChangesTable.rowKey],
          set: {
            // Facts only. The four counts and notes are deliberately ABSENT —
            // the merge already carried them, and listing them here would let a
            // future edit re-introduce the clobber this design exists to stop.
            customer: row.customer ?? null, employee: row.employee ?? null,
            peopleCount: row.peopleCount ?? 1, route: row.route ?? null,
            changeType: row.changeType, changeTypeRaw: row.changeTypeRaw ?? null,
            amount: row.amount == null ? null : String(row.amount),
            hours: row.hours == null ? null : String(row.hours),
            weekEnding: row.weekEnding ?? null,
            effectiveDate: row.effectiveDate ?? null,
            isRetro: row.isRetro ?? false, action: row.action,
            supersedes: row.supersedes ?? null,
            pairedWithRowKey: row.pairedWithRowKey ?? null,
            requestedBy: row.requestedBy ?? null, approvedBy: row.approvedBy ?? null,
            category: row.category ?? null,
            // Provenance is a fact too. These were insert-only once, which
            // meant a re-sweep could never backfill the email link onto a row
            // that predates it — and the Create-PDF flow lives on that link.
            // (The merge carried the stored values when a sweep omits them,
            // so writing the merged row here cannot blank anything.)
            conversationId: row.conversationId ?? null,
            sourceMessageId: row.sourceMessageId ?? null,
            sourceRef: row.sourceRef ?? null,
            sourceReceivedAt: row.sourceReceivedAt ?? null,
            needsDecision: row.needsDecision ?? false,
            decisionQuestion: row.decisionQuestion ?? null,
            decisionOwner: row.decisionOwner ?? null,
            sweepState: row.sweepState ?? "unchanged",
            lastSweptAt: now, updatedAt: now,
          },
        });
      }
      out["changes"] = {
        created: merged.created, changed: merged.changed,
        carried: merged.carried, report: merged.report.slice(0, 50),
      };
    }

    if (body.sources?.length) {
      for (const s of body.sources) {
        await db.insert(schema.payrollChangeSourcesTable).values({
          periodId: period.id, messageId: s.messageId,
          conversationId: s.conversationId ?? null, subject: s.subject ?? null,
          sender: s.sender ?? null,
          receivedAt: s.receivedAt ? new Date(s.receivedAt) : null,
          categories: s.categories ?? null,
          attachmentNames: s.attachmentNames ?? null,
          drivesRowKeys: s.drivesRowKeys ?? null,
        }).onConflictDoUpdate({
          target: [schema.payrollChangeSourcesTable.periodId,
                   schema.payrollChangeSourcesTable.messageId],
          set: { drivesRowKeys: s.drivesRowKeys ?? null, seenAt: new Date() },
        });
      }
      out["sources"] = body.sources.length;
    }

    res.json({ ok: true, ...out });
  });

/** Same missing-table guard for the bridge, so a push says why it failed. */
machinePayrollRouter.use((
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) { next(err); return; }
  const code = typeof err === "object" && err !== null
    ? (err as { code?: unknown }).code : undefined;
  if (code === "42P01") {
    // The bridge logs this verbatim and exits non-zero, so it has to be plain.
    res.status(503).json({
      error: "The payroll tables have not been created in this database yet.",
      code: "payroll_schema_missing",
    });
    return;
  }
  next(err);
});
