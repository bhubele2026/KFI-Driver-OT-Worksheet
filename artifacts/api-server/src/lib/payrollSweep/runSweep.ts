import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db.js";
import { logger } from "../logger.js";
import { ensurePayrollPeriod } from "../payrollPeriodStore.js";
import { payDateFor } from "../payrollPeriod.js";
import type { SweptRow } from "../payrollChangeMerge.js";
import {
  PAYROLL_MAILBOX, getMessage, listMessages, mailConfigured,
  type MailBody, type MailHeader,
} from "./graphMail.js";
import { bodyHash, dedupeHeaders, prefilterVerdict } from "./prefilter.js";
import { MAX_PARALLEL, classifyMessage, mapLimit, triage } from "./classify.js";
import { buildRows, type SourceFacts } from "./buildRows.js";
import { rowIsFaithful, wouldDisturbVerified } from "./verify.js";
import { loadStored, persistChanges, persistSources } from "./persistSweep.js";

/**
 * ⚠️⚠️ DORMANT — NOTHING IMPORTS THIS TODAY. Read `macQueue.ts` instead.
 *
 * This is the direct-Graph path: the server reads payroll@ itself on an
 * application credential. It is kept, working and typechecked, because it is
 * the RIGHT shape — no laptop in the loop — and becomes reachable the moment
 * an administrator grants app-only `Mail.Read` to a scoped app registration.
 * Brad holds no directory role (checked 2026-09-16), and the one pre-consented
 * app in the tenant turned out to be disabled, so until IT acts the mailbox is
 * reachable only from his Mac and `macQueue.ts` drives it.
 *
 * ⚠️ If you change a judgment rule, a gate, or the period-placement logic,
 * change it in the SHARED modules (`classify`, `verify`, `buildRows`,
 * `persistSweep`) — both paths call those. Do not fix a bug in one
 * orchestrator and not the other.
 *
 * The nightly (and on-demand) mailbox sweep.
 *
 * Replaces a procedure I used to run by hand: read payroll@ over the period,
 * classify every payroll-affecting thread into action rows, and post them to
 * the Changes & Deductions board. The hand run on 2026-09-16 produced 76 rows
 * from 59 threads; those threads are the regression corpus in `__fixtures__/`.
 *
 * ⚠️ NOTHING HERE MAY THROW INTO A REQUEST. The button starts this and returns
 * a run id immediately; the nightly tick starts it and forgets it. Every exit
 * writes a run row, because a sweep that failed silently is indistinguishable
 * from a sweep that found nothing — and those need very different responses.
 */

/** Advisory-lock key. Arbitrary but STABLE — changing it lets two runs overlap. */
const SWEEP_LOCK_KEY = 8_123_470_001;

/** A run still 'running' after this is presumed dead and may be superseded. */
const LEASE_MS = 45 * 60 * 1000;

/** Graph pages and silently drops the oldest on a wide window — slice it. */
const SLICE_DAYS = 3;

/** Re-read a little before the last window: mail gets edited, filed and re-sent. */
const OVERLAP_DAYS = 2;

/** First run has no watermark. Two pay periods, the way the hand run scoped it. */
const FIRST_RUN_DAYS = 14;

export type SweepTrigger = "nightly" | "manual";

export type SweepOptions = {
  trigger: SweepTrigger;
  triggeredBy?: string | null;
  /** Classify and verify, write nothing. For rehearsing against real mail. */
  dryRun?: boolean;
  now?: Date;
};

export type SweepOutcome = {
  runId: number | null;
  status: "ok" | "failed" | "skipped";
  skippedReason?: string;
  counts: Record<string, unknown>;
};

/**
 * Claim the right to run, and record the claim in the same transaction.
 *
 * ⚠️ TWO REPLICAS. This app runs min=2/max=2, so a bare interval fires twice a
 * night. `pg_try_advisory_xact_lock` is transaction-scoped — it dies with the
 * transaction, so there is nothing to leak if the process is killed — but that
 * also means it is released the moment this commits. The lock alone therefore
 * does NOT serialise the sweep; the run row written INSIDE it does. The second
 * replica takes the lock a moment later, sees a live claim, and stands down.
 */
async function claimRun(
  opts: SweepOptions,
  window: { from: Date; to: Date },
  now: Date,
): Promise<{ runId: number } | { skipped: string }> {
  return db.transaction(async (tx) => {
    const [got] = (
      await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) AS got`)
    ).rows as Array<{ got: boolean }>;
    if (!got?.got) return { skipped: "another replica is sweeping" };

    const recent = await tx.select().from(schema.payrollSweepRunsTable)
      .orderBy(desc(schema.payrollSweepRunsTable.claimedAt)).limit(1);
    const last = recent[0];

    if (last?.status === "running"
        && now.getTime() - new Date(last.claimedAt).getTime() < LEASE_MS) {
      return { skipped: "a sweep is already running" };
    }
    // The nightly job ticks hourly and checks the hour; belt-and-braces so a
    // restart that crosses the sweep hour cannot run it a second time.
    if (opts.trigger === "nightly" && last?.status === "ok"
        && new Date(last.claimedAt).toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
      return { skipped: "already swept today" };
    }

    const [row] = await tx.insert(schema.payrollSweepRunsTable).values({
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy ?? null,
      windowFrom: window.from,
      windowTo: window.to,
      status: "running",
      dryRun: opts.dryRun === true,
      claimedAt: now,
      attempt: (last?.attempt ?? 0) + 1,
    }).returning({ id: schema.payrollSweepRunsTable.id });
    return { runId: row!.id };
  });
}

/** Where to start reading: just before the last good run finished. */
async function windowStart(now: Date): Promise<Date> {
  const rows = await db.select().from(schema.payrollSweepRunsTable)
    .where(eq(schema.payrollSweepRunsTable.status, "ok"))
    .orderBy(desc(schema.payrollSweepRunsTable.windowTo)).limit(1);
  const last = rows[0];
  if (!last) return new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000);
  return new Date(new Date(last.windowTo).getTime() - OVERLAP_DAYS * 86_400_000);
}

/** Pay dates a sweep must never repopulate. */
async function closedPayDates(): Promise<Set<string>> {
  const rows = await db.select({ payDate: schema.payrollPeriodsTable.payDate })
    .from(schema.payrollPeriodsTable)
    .where(eq(schema.payrollPeriodsTable.status, "closed"));
  return new Set(rows.map((r) => r.payDate));
}

async function markSeen(
  h: MailHeader,
  verdict: string,
  reason: string,
  extra: { bodyHash?: string; rowsProduced?: number } = {},
): Promise<void> {
  const now = new Date();
  await db.insert(schema.payrollSweepSeenMessagesTable).values({
    internetMessageId: h.internetMessageId,
    graphMessageId: h.id,
    conversationId: h.conversationId,
    subject: h.subject,
    sender: h.from,
    receivedAt: h.receivedAt ? new Date(h.receivedAt) : null,
    bodyHash: extra.bodyHash ?? null,
    verdict,
    verdictReason: reason,
    rowsProduced: extra.rowsProduced ?? 0,
    firstSeenAt: now,
    lastSeenAt: now,
  }).onConflictDoUpdate({
    target: schema.payrollSweepSeenMessagesTable.internetMessageId,
    set: {
      graphMessageId: h.id, verdict, verdictReason: reason,
      bodyHash: extra.bodyHash ?? null,
      rowsProduced: extra.rowsProduced ?? 0,
      lastSeenAt: now,
    },
  });
}

export async function runPayrollSweep(opts: SweepOptions): Promise<SweepOutcome> {
  const now = opts.now ?? new Date();
  const todayIso = now.toISOString().slice(0, 10);

  if (!mailConfigured()) {
    return {
      runId: null, status: "skipped",
      skippedReason: "mail credentials are not configured (PAYROLL_MAIL_TENANT_ID / PAYROLL_MAIL_CLIENT_SECRET)",
      counts: {},
    };
  }

  const from = await windowStart(now);
  const claim = await claimRun(opts, { from, to: now }, now);
  if ("skipped" in claim) {
    logger.info({ reason: claim.skipped }, "payroll sweep stood down");
    return { runId: null, status: "skipped", skippedReason: claim.skipped, counts: {} };
  }
  const runId = claim.runId;

  const counts: Record<string, unknown> = {
    mailbox: PAYROLL_MAILBOX,
    windowFrom: from.toISOString(),
    windowTo: now.toISOString(),
  };

  try {
    // ---- 1. headers, in slices ------------------------------------------
    const headers: MailHeader[] = [];
    for (let t = from.getTime(); t < now.getTime(); t += SLICE_DAYS * 86_400_000) {
      const sliceFrom = new Date(t);
      const sliceTo = new Date(Math.min(t + SLICE_DAYS * 86_400_000, now.getTime()));
      headers.push(...(await listMessages(sliceFrom, sliceTo)));
    }
    counts.headers = headers.length;

    // ---- 2. dedupe (folder copies share an internetMessageId) ------------
    const unique = dedupeHeaders(headers);
    counts.deduped = unique.length;

    // ---- 3. deterministic skip ------------------------------------------
    const candidates: MailHeader[] = [];
    for (const h of unique) {
      const v = prefilterVerdict(h);
      if (!v.keep) { await markSeen(h, "skip", v.reason); continue; }
      candidates.push(h);
    }
    counts.prefiltered = candidates.length;

    // ---- 4. drop what we have already classified -------------------------
    const known = candidates.length
      ? await db.select({
          id: schema.payrollSweepSeenMessagesTable.internetMessageId,
          verdict: schema.payrollSweepSeenMessagesTable.verdict,
        }).from(schema.payrollSweepSeenMessagesTable)
          .where(inArray(schema.payrollSweepSeenMessagesTable.internetMessageId,
                         candidates.map((c) => c.internetMessageId)))
      : [];
    const alreadyDone = new Set(known.filter((k) => k.verdict === "classified").map((k) => k.id));
    const fresh = candidates.filter((c) => !alreadyDone.has(c.internetMessageId));
    counts.alreadyClassified = alreadyDone.size;

    // ---- 5. triage on headers -------------------------------------------
    const verdicts = await triage(fresh);
    const keepIds = new Set(verdicts.filter((v) => v.keep).map((v) => v.internetMessageId));
    const toRead = fresh.filter((h) => keepIds.has(h.internetMessageId));
    for (const h of fresh) {
      if (keepIds.has(h.internetMessageId)) continue;
      const why = verdicts.find((v) => v.internetMessageId === h.internetMessageId)?.why ?? "triaged out";
      await markSeen(h, "skip", why);
    }
    counts.triaged = toRead.length;

    // ---- 6. bodies + classification --------------------------------------
    const openPayDate = payDateFor(todayIso);
    const closed = await closedPayDates();

    type Classified = {
      msg: MailBody;
      built: Array<{ ref: string; payDate: string; row: SweptRow }>;
      rejected: ReturnType<typeof buildRows>["rejected"];
    };

    // ⚠️ Take mapLimit's ORDERED return value. An earlier draft pushed into a
    // shared array and then mutated `arr[arr.length - 1]`, which races the
    // moment more than one worker is in flight — results land on the wrong
    // message. Nothing here may write to shared state.
    const settled = await mapLimit<MailHeader, Classified | null>(
      toRead, MAX_PARALLEL, async (h) => {
        let msg: MailBody;
        try {
          msg = await getMessage(h.id);
        } catch (err) {
          // ⚠️ Expected, not exceptional: Tiana files mail into the PD folders
          // while this runs, and a filed message gets a NEW Graph id. Leave it
          // unseen so the next run picks it up under its current id.
          logger.warn({ err, subject: h.subject },
            "payroll sweep: message unreadable (likely refiled mid-run)");
          return null;
        }
        const result = await classifyMessage(msg, { openPayDate, todayIso });
        const facts: SourceFacts = {
          conversationId: msg.conversationId,
          sourceMessageId: msg.id,
          sourceRef: msg.subject,
          sourceReceivedAt: msg.receivedAt ? new Date(msg.receivedAt) : null,
          category: msg.categories.find((c) =>
            !/^(red|orange|yellow|green|blue|purple)\s+category$/i.test(c)) ?? null,
        };
        const { built, rejected } = buildRows(result.rows, facts, {
          todayIso, closedPayDates: closed,
        });
        await markSeen(h, "classified", result.note || "classified",
          { bodyHash: bodyHash(msg.text), rowsProduced: built.length });
        return { msg, built, rejected };
      },
    );
    const classified = settled.filter((c): c is Classified => c !== null);
    counts.classified = classified.length;

    // ---- 7. verify, then post or queue -----------------------------------
    type Pending = { payDate: string; row: SweptRow; msg: MailBody };
    const confident: Pending[] = [];
    const queued: Array<Pending & { reason: string; detail: string }> = [];

    for (const c of classified) {
      for (const b of c.built) {
        const faithful = rowIsFaithful(
          {
            action: b.row.action,
            amount: b.row.amount ?? null,
            hours: b.row.hours ?? null,
            weekEnding: b.row.weekEnding ?? null,
            effectiveDate: b.row.effectiveDate ?? null,
          },
          c.msg.text,
        );
        if (!faithful.ok) {
          queued.push({
            payDate: b.payDate, row: b.row, msg: c.msg,
            reason: faithful.reason, detail: faithful.detail,
          });
          continue;
        }
        confident.push({ payDate: b.payDate, row: b.row, msg: c.msg });
      }
      // A row the builder refused is still shown to a human, with the reason.
      // Refusing quietly would be the same as inventing quietly.
      for (const r of c.rejected) {
        queued.push({
          payDate: r.payDate,
          row: {
            rowKey: `rejected:${c.msg.id.slice(-12)}:${r.ref}`,
            changeType: "Other" as SweptRow["changeType"],
            action: String((r.row as { action?: unknown }).action ?? "(no instruction)"),
            employee: (r.row as { employee?: string | null }).employee ?? null,
            customer: (r.row as { customer?: string | null }).customer ?? null,
          },
          msg: c.msg, reason: r.reason, detail: r.detail,
        });
      }
    }

    // ---- 8. write, one period at a time ----------------------------------
    const byPayDate = new Map<string, Pending[]>();
    for (const p of confident) {
      const list = byPayDate.get(p.payDate) ?? [];
      list.push(p);
      byPayDate.set(p.payDate, list);
    }

    const perPeriod: Record<string, unknown> = {};
    let posted = 0;

    for (const [payDate, pending] of [...byPayDate.entries()].sort()) {
      const period = await ensurePayrollPeriod(payDate, false);
      const stored = await loadStored(period.id);
      const storedByKey = new Map(stored.map((s) => [s.rowKey, s]));

      // ⚠️ The last gate, and the one the merge cannot apply: a row someone
      // has already ticked must not have its numbers moved underneath her.
      const safe: SweptRow[] = [];
      for (const p of pending) {
        const disturb = wouldDisturbVerified(p.row, storedByKey.get(p.row.rowKey));
        if (!disturb.ok) {
          queued.push({ ...p, reason: disturb.reason, detail: disturb.detail });
          continue;
        }
        safe.push(p.row);
      }

      if (opts.dryRun) {
        perPeriod[payDate] = { wouldPost: safe.length };
        posted += safe.length;
        continue;
      }

      // ⚠️ guardEmpty stays TRUE: this is the final write for the period, and
      // an empty sweep over a populated ledger means the connector died.
      const result = await persistChanges(period.id, safe, { guardEmpty: true });
      if ("refused" in result) {
        perPeriod[payDate] = { refused: result.refused };
        logger.warn({ payDate, reason: result.refused }, "payroll sweep refused");
        continue;
      }
      const sources = [...new Map(pending.map((p) => [p.msg.id, p])).values()].map((p) => ({
        messageId: p.msg.id,
        conversationId: p.msg.conversationId,
        subject: p.msg.subject,
        sender: p.msg.from,
        receivedAt: p.msg.receivedAt ? new Date(p.msg.receivedAt) : null,
        categories: p.msg.categories,
        attachmentNames: p.msg.attachmentNames,
        drivesRowKeys: pending.filter((q) => q.msg.id === p.msg.id).map((q) => q.row.rowKey),
      }));
      await persistSources(period.id, sources);
      perPeriod[payDate] = {
        created: result.created, changed: result.changed,
        carried: result.carried, sources: sources.length,
      };
      posted += result.created + result.changed;
    }

    // ---- 9. the review queue ---------------------------------------------
    if (!opts.dryRun) {
      for (const q of queued) {
        await db.insert(schema.payrollSweepProposalsTable).values({
          runId, periodId: null, payDate: q.payDate, rowKey: q.row.rowKey,
          row: q.row as unknown as Record<string, unknown>,
          reason: q.reason, detail: q.detail,
          employee: q.row.employee ?? null, customer: q.row.customer ?? null,
          action: q.row.action ?? null, state: "pending",
        }).onConflictDoUpdate({
          target: [schema.payrollSweepProposalsTable.payDate,
                   schema.payrollSweepProposalsTable.rowKey],
          set: {
            runId, row: q.row as unknown as Record<string, unknown>,
            reason: q.reason, detail: q.detail, createdAt: new Date(),
          },
        });
      }
    }

    counts.posted = posted;
    counts.queued = queued.length;
    counts.periods = perPeriod;

    await db.update(schema.payrollSweepRunsTable)
      .set({ status: "ok", counts, finishedAt: new Date() })
      .where(eq(schema.payrollSweepRunsTable.id, runId));

    logger.info({ runId, ...counts }, "payroll sweep complete");
    return { runId, status: "ok", counts };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.payrollSweepRunsTable)
      .set({ status: "failed", errMsg, counts, finishedAt: new Date() })
      .where(eq(schema.payrollSweepRunsTable.id, runId))
      .catch(() => undefined);
    logger.error({ err, runId }, "payroll sweep failed");
    return { runId, status: "failed", counts: { ...counts, errMsg } };
  }
}
