import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../lib/db.js";
import { requirePulseKey } from "./pulse.js";
import { normalizeChangeType } from "../lib/payrollChangeTypes.js";
import {
  mergeSweep, sweepIsSafeToApply, rowKeyFor,
  type SweptRow, type StoredRow,
} from "../lib/payrollChangeMerge.js";
import { ensurePayrollPeriod } from "../lib/payrollPeriodStore.js";

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
  kind?: "changes" | "artifacts" | "ping";
  /** True when more chunks follow; the empty-sweep guard is skipped until the
   *  last one, or a chunked push would look like an empty sweep. */
  more?: boolean;
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
    const payDate = body.payDate ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
      res.status(400).json({ error: "payDate must be YYYY-MM-DD" });
      return;
    }
    if (body.kind === "ping") {
      res.json({ ok: true, pong: true });
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
        return {
          ...c, rowKey, changeType,
          changeTypeRaw: c.changeTypeRaw ?? c.changeType,
          action: c.action,
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
        conversationId: r.conversationId, sourceRef: r.sourceRef,
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
