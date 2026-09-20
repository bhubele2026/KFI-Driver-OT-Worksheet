import { eq } from "drizzle-orm";
import { db, schema } from "../db.js";
import {
  mergeSweep, sweepIsSafeToApply, type StoredRow, type SweptRow,
} from "../payrollChangeMerge.js";

/**
 * The one writer of `payroll_changes` from a sweep.
 *
 * Extracted from `routes/machinePayroll.ts` so the machine bridge (the Mac
 * push) and the in-server nightly sweep cannot drift apart. Two writers of a
 * payroll ledger with subtly different upsert SET blocks is exactly how a
 * human's check-offs get clobbered on one path and not the other.
 *
 * ⚠️ THE SET BLOCK OMITS THE FOUR VERIFICATION COUNTS AND `notes` ON PURPOSE.
 * The merge has already carried them forward; listing them here would let a
 * later edit re-introduce the clobber this design exists to prevent. The whole
 * pdf* block is likewise absent — those belong to the button and the executor.
 */

export type PersistResult = {
  created: number;
  changed: number;
  carried: number;
  report: string[];
};

export type SourceRecord = {
  messageId: string;
  conversationId?: string | null;
  subject?: string | null;
  sender?: string | null;
  receivedAt?: Date | string | null;
  categories?: string[] | null;
  attachmentNames?: string[] | null;
  drivesRowKeys?: string[] | null;
};

/** Read the period's rows in the shape the merge expects. */
export async function loadStored(periodId: number): Promise<StoredRow[]> {
  const existing = await db.select().from(schema.payrollChangesTable)
    .where(eq(schema.payrollChangesTable.periodId, periodId));
  return existing.map((r) => ({
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
}

/**
 * Merge a sweep into one period and write it.
 *
 * `guardEmpty` must be TRUE on the final push for a period and false mid-chunk:
 * a chunked push legitimately sends a small batch, and refusing it would break
 * the very thing the guard protects.
 */
export async function persistChanges(
  periodId: number,
  swept: SweptRow[],
  opts: { guardEmpty: boolean },
): Promise<PersistResult | { refused: string }> {
  const stored = await loadStored(periodId);

  // ⚠️ Zero rows and a dead mail connector are indistinguishable from here,
  // and the M365 token HAS died mid-run before. Never write an empty sweep
  // over a ledger that has rows — keep what is there and say so.
  if (opts.guardEmpty) {
    const safe = sweepIsSafeToApply(swept.length, stored.length);
    if (!safe.ok) return { refused: safe.reason };
  }

  const merged = mergeSweep(swept, stored);
  const now = new Date();

  for (const row of merged.rows) {
    const facts = {
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
      // Provenance is a fact too — and the Create-PDF flow lives on this link,
      // so a re-sweep must be able to backfill it onto an older row.
      conversationId: row.conversationId ?? null,
      sourceMessageId: row.sourceMessageId ?? null,
      sourceRef: row.sourceRef ?? null,
      sourceReceivedAt: row.sourceReceivedAt ?? null,
      needsDecision: row.needsDecision ?? false,
      decisionQuestion: row.decisionQuestion ?? null,
      decisionOwner: row.decisionOwner ?? null,
      sweepState: row.sweepState ?? "unchanged",
      lastSweptAt: now,
    };

    await db.insert(schema.payrollChangesTable).values({
      periodId, rowKey: row.rowKey, ...facts,
      enteredZenople: row.enteredZenople, verifiedTs: row.verifiedTs,
      verifiedPas: row.verifiedPas, documentationSaved: row.documentationSaved,
      notes: row.notes ?? null,
    }).onConflictDoUpdate({
      target: [schema.payrollChangesTable.periodId, schema.payrollChangesTable.rowKey],
      set: { ...facts, updatedAt: now },
    });
  }

  return {
    created: merged.created, changed: merged.changed,
    carried: merged.carried, report: merged.report,
  };
}

/** Record the messages a sweep read, so a row traces back to its email. */
export async function persistSources(
  periodId: number,
  sources: SourceRecord[],
): Promise<number> {
  for (const s of sources) {
    const receivedAt = s.receivedAt
      ? (s.receivedAt instanceof Date ? s.receivedAt : new Date(s.receivedAt))
      : null;
    await db.insert(schema.payrollChangeSourcesTable).values({
      periodId, messageId: s.messageId,
      conversationId: s.conversationId ?? null, subject: s.subject ?? null,
      sender: s.sender ?? null,
      receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
      categories: s.categories ?? null,
      attachmentNames: s.attachmentNames ?? null,
      drivesRowKeys: s.drivesRowKeys ?? null,
    }).onConflictDoUpdate({
      target: [schema.payrollChangeSourcesTable.periodId,
               schema.payrollChangeSourcesTable.messageId],
      set: { drivesRowKeys: s.drivesRowKeys ?? null, seenAt: new Date() },
    });
  }
  return sources.length;
}
