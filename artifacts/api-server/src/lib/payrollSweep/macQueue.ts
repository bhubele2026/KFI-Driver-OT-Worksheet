import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db.js";
import { logger } from "../logger.js";
import { payDateFor } from "../payrollPeriod.js";
import { ensurePayrollPeriod } from "../payrollPeriodStore.js";
import type { MailBody, MailHeader } from "./graphMail.js";
import { bodyHash, dedupeHeaders, prefilterVerdict } from "./prefilter.js";
import { MAX_PARALLEL, classifyMessage, mapLimit, triage } from "./classify.js";
import { buildRows, type SourceFacts } from "./buildRows.js";
import { rowIsFaithful, wouldDisturbVerified } from "./verify.js";
import { loadStored, persistChanges, persistSources } from "./persistSweep.js";

/**
 * The sweep, done through Brad's Mac.
 *
 * ⚠️ WHY NOT JUST READ THE MAILBOX FROM HERE. App-only Graph access needs an
 * administrator's consent, and Brad holds no directory role — confirmed
 * 2026-09-16, not assumed. The one pre-consented app registration in the
 * tenant (`Outlook-Email-Sandbox`) turned out to be DISABLED. So the mailbox
 * is reachable only from the Mac, through the delegated access Brad already
 * has as a person — exactly the arrangement the Create-PDF executor uses.
 *
 * THE SPLIT: this server owns the queue, the judgment and the ledger. The Mac
 * owns nothing but fetching. It is told which messages to read and pushes them
 * back; it makes no decisions, so nothing about payroll correctness depends on
 * a laptop.
 *
 * ⭐ THE PROPERTY THAT MAKES A SLEEPING MAC FINE: pressing the button (or the
 * 5am tick) does not read mail — it writes a QUEUED run row here, in Azure,
 * which never sleeps. The Mac drains the queue when it next wakes. Work is
 * deferred, never lost. And a gap of several days collapses into ONE sweep
 * covering the whole gap, because the window is computed at claim time from
 * the last successful run — not at the time the run was queued.
 *
 * `graphMail.ts` is kept and still works; if IT ever grants the application
 * permission, the direct path returns without any of this being rewritten.
 */

/** Re-read a little before the last window: mail gets edited, filed, re-sent. */
const OVERLAP_DAYS = 2;
/** First run ever has no watermark. Two pay periods, as the hand run scoped it. */
const FIRST_RUN_DAYS = 14;
/** A claimed run that goes quiet this long is presumed dead and re-claimable. */
const LEASE_MS = 45 * 60 * 1000;

export type QueueOutcome = {
  runId: number;
  status: "queued" | "running";
  alreadyQueued: boolean;
};

/**
 * Ask for a sweep. Idempotent on purpose.
 *
 * ⚠️ If one is already waiting or in flight, this returns THAT one rather than
 * stacking a second. Three nights asleep must produce one sweep on waking, not
 * three runs racing each other over the same mailbox.
 */
export async function queueSweep(
  trigger: "nightly" | "manual",
  triggeredBy: string | null,
): Promise<QueueOutcome> {
  const now = new Date();
  const open = await db.select().from(schema.payrollSweepRunsTable)
    .where(inArray(schema.payrollSweepRunsTable.status, ["queued", "running"]))
    .orderBy(asc(schema.payrollSweepRunsTable.createdAt)).limit(1);

  const live = open[0];
  if (live) {
    // A "running" row whose executor died must not block the queue forever.
    const age = now.getTime() - new Date(live.claimedAt).getTime();
    if (live.status === "running" && age > LEASE_MS) {
      await db.update(schema.payrollSweepRunsTable)
        .set({ status: "queued", errMsg: "the previous attempt stopped without reporting" })
        .where(eq(schema.payrollSweepRunsTable.id, live.id));
      logger.warn({ runId: live.id, ageMs: age }, "payroll sweep: stale run requeued");
      return { runId: live.id, status: "queued", alreadyQueued: true };
    }
    return {
      runId: live.id,
      status: live.status as "queued" | "running",
      alreadyQueued: true,
    };
  }

  // The window is left provisional here and recomputed at claim time, so a run
  // that waits three days for a laptop still sweeps up to the moment it runs.
  const [row] = await db.insert(schema.payrollSweepRunsTable).values({
    trigger, triggeredBy,
    windowFrom: new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000),
    windowTo: now,
    status: "queued",
    claimedAt: now,
    counts: {},
  }).returning({ id: schema.payrollSweepRunsTable.id });
  return { runId: row!.id, status: "queued", alreadyQueued: false };
}

/** How many sweeps are waiting for the Mac — the long-poll's answer. */
export async function pendingSweeps(): Promise<number> {
  const [c] = await db.select({ n: sql<number>`count(*)::int` })
    .from(schema.payrollSweepRunsTable)
    .where(eq(schema.payrollSweepRunsTable.status, "queued"));
  return c?.n ?? 0;
}

export type SweepClaim = {
  runId: number;
  windowFrom: string;
  windowTo: string;
  /** Messages already classified — the Mac skips fetching these again. */
  seenMessageIds: string[];
};

/**
 * Hand the oldest queued sweep to the Mac.
 *
 * The window is computed HERE, now, from the last successful run — which is
 * what makes a three-day sleep collapse into one three-day sweep.
 */
export async function claimSweep(): Promise<SweepClaim | null> {
  const now = new Date();
  const queued = await db.select().from(schema.payrollSweepRunsTable)
    .where(eq(schema.payrollSweepRunsTable.status, "queued"))
    .orderBy(asc(schema.payrollSweepRunsTable.createdAt)).limit(1);
  const run = queued[0];
  if (!run) return null;

  const lastOk = await db.select().from(schema.payrollSweepRunsTable)
    .where(eq(schema.payrollSweepRunsTable.status, "ok"))
    .orderBy(desc(schema.payrollSweepRunsTable.windowTo)).limit(1);
  const from = lastOk[0]
    ? new Date(new Date(lastOk[0].windowTo).getTime() - OVERLAP_DAYS * 86_400_000)
    : new Date(now.getTime() - FIRST_RUN_DAYS * 86_400_000);

  await db.update(schema.payrollSweepRunsTable).set({
    status: "running", windowFrom: from, windowTo: now, claimedAt: now,
    attempt: run.attempt + 1,
  }).where(eq(schema.payrollSweepRunsTable.id, run.id));

  const seen = await db.select({
    id: schema.payrollSweepSeenMessagesTable.internetMessageId,
  }).from(schema.payrollSweepSeenMessagesTable)
    .where(eq(schema.payrollSweepSeenMessagesTable.verdict, "classified"));

  return {
    runId: run.id,
    windowFrom: from.toISOString(),
    windowTo: now.toISOString(),
    seenMessageIds: seen.map((s) => s.id),
  };
}

/**
 * The Mac pushes every header it found; we decide which bodies are worth
 * reading. Keeping this judgment server-side means the Mac stays dumb and the
 * skip rules live in one place with their tests.
 */
export async function decideBodies(
  runId: number,
  headers: MailHeader[],
): Promise<{ wantBodies: string[]; skipped: number }> {
  const unique = dedupeHeaders(headers);
  const candidates: MailHeader[] = [];
  let skipped = 0;

  for (const h of unique) {
    const v = prefilterVerdict(h);
    if (!v.keep) {
      skipped++;
      await markSeen(h, "skip", v.reason);
      continue;
    }
    candidates.push(h);
  }

  const verdicts = await triage(candidates);
  const keep = new Set(verdicts.filter((v) => v.keep).map((v) => v.internetMessageId));
  for (const h of candidates) {
    if (keep.has(h.internetMessageId)) continue;
    skipped++;
    const why = verdicts.find((v) => v.internetMessageId === h.internetMessageId)?.why ?? "triaged out";
    await markSeen(h, "skip", why);
  }

  const want = candidates.filter((h) => keep.has(h.internetMessageId));
  await db.update(schema.payrollSweepRunsTable).set({
    counts: { headers: headers.length, deduped: unique.length, wantBodies: want.length, skipped },
  }).where(eq(schema.payrollSweepRunsTable.id, runId));

  // The Mac addresses messages by the Graph id it saw them under, because that
  // is the only id it can fetch with — even though identity is the internet id.
  return { wantBodies: want.map((h) => h.id), skipped };
}

async function markSeen(
  h: MailHeader, verdict: string, reason: string,
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
    verdict, verdictReason: reason,
    rowsProduced: extra.rowsProduced ?? 0,
    firstSeenAt: now, lastSeenAt: now,
  }).onConflictDoUpdate({
    target: schema.payrollSweepSeenMessagesTable.internetMessageId,
    set: {
      graphMessageId: h.id, verdict, verdictReason: reason,
      bodyHash: extra.bodyHash ?? null,
      rowsProduced: extra.rowsProduced ?? 0, lastSeenAt: now,
    },
  });
}

export type IngestResult = { classified: number; posted: number; queuedForReview: number };

/**
 * Classify a chunk of message bodies and stage what they contain.
 *
 * Every gate from the direct-Graph path applies unchanged: a figure must
 * appear in its source email, and a row must not move a number under one
 * somebody has already verified.
 */
export async function ingestBodies(
  runId: number,
  messages: MailBody[],
): Promise<IngestResult> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const openPayDate = payDateFor(todayIso);
  const closedRows = await db.select({ payDate: schema.payrollPeriodsTable.payDate })
    .from(schema.payrollPeriodsTable)
    .where(eq(schema.payrollPeriodsTable.status, "closed"));
  const closed = new Set(closedRows.map((r) => r.payDate));

  type Classified = {
    msg: MailBody;
    built: Array<{ ref: string; payDate: string; row: ReturnType<typeof buildRows>["built"][number]["row"] }>;
    rejected: ReturnType<typeof buildRows>["rejected"];
  };

  const settled = await mapLimit<MailBody, Classified>(messages, MAX_PARALLEL, async (msg) => {
    const result = await classifyMessage(msg, { openPayDate, todayIso });
    const facts: SourceFacts = {
      conversationId: msg.conversationId,
      sourceMessageId: msg.id,
      sourceRef: msg.subject,
      sourceReceivedAt: msg.receivedAt ? new Date(msg.receivedAt) : null,
      category: msg.categories.find((c) =>
        !/^(red|orange|yellow|green|blue|purple)\s+category$/i.test(c)) ?? null,
    };
    const { built, rejected } = buildRows(result.rows, facts, { todayIso, closedPayDates: closed });
    await markSeen(msg, "classified", result.note || "classified",
      { bodyHash: bodyHash(msg.text), rowsProduced: built.length });
    return { msg, built, rejected };
  });

  type Pending = { payDate: string; row: Classified["built"][number]["row"]; msg: MailBody };
  const confident: Pending[] = [];
  const queued: Array<Pending & { reason: string; detail: string }> = [];

  for (const c of settled) {
    for (const b of c.built) {
      const faithful = rowIsFaithful({
        action: b.row.action, amount: b.row.amount ?? null, hours: b.row.hours ?? null,
        weekEnding: b.row.weekEnding ?? null, effectiveDate: b.row.effectiveDate ?? null,
      }, c.msg.text);
      if (!faithful.ok) {
        queued.push({ payDate: b.payDate, row: b.row, msg: c.msg, reason: faithful.reason, detail: faithful.detail });
        continue;
      }
      confident.push({ payDate: b.payDate, row: b.row, msg: c.msg });
    }
    for (const r of c.rejected) {
      queued.push({
        payDate: r.payDate,
        row: {
          rowKey: `rejected:${c.msg.id.slice(-12)}:${r.ref}`,
          changeType: "Other" as never,
          action: String((r.row as { action?: unknown }).action ?? "(no instruction)"),
          employee: (r.row as { employee?: string | null }).employee ?? null,
          customer: (r.row as { customer?: string | null }).customer ?? null,
        } as never,
        msg: c.msg, reason: r.reason, detail: r.detail,
      });
    }
  }

  const byPayDate = new Map<string, Pending[]>();
  for (const p of confident) {
    const list = byPayDate.get(p.payDate) ?? [];
    list.push(p);
    byPayDate.set(p.payDate, list);
  }

  let posted = 0;
  for (const [payDate, pending] of [...byPayDate.entries()].sort()) {
    const period = await ensurePayrollPeriod(payDate, false);
    const stored = await loadStored(period.id);
    const storedByKey = new Map(stored.map((s) => [s.rowKey, s]));

    const safe: Array<Classified["built"][number]["row"]> = [];
    for (const p of pending) {
      const disturb = wouldDisturbVerified(p.row, storedByKey.get(p.row.rowKey));
      if (!disturb.ok) {
        queued.push({ ...p, reason: disturb.reason, detail: disturb.detail });
        continue;
      }
      safe.push(p.row);
    }

    // ⚠️ guardEmpty is FALSE here: bodies arrive in chunks, so a chunk with no
    // postable rows is normal and must not look like a dead connector. The
    // real empty-sweep check belongs to the whole run, not a chunk of it.
    const result = await persistChanges(period.id, safe, { guardEmpty: false });
    if ("refused" in result) {
      logger.warn({ payDate, reason: result.refused }, "payroll sweep chunk refused");
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
    posted += result.created + result.changed;
  }

  for (const q of queued) {
    await db.insert(schema.payrollSweepProposalsTable).values({
      runId, periodId: null, payDate: q.payDate, rowKey: q.row.rowKey,
      row: q.row as never, reason: q.reason, detail: q.detail,
      employee: q.row.employee ?? null, customer: q.row.customer ?? null,
      action: q.row.action ?? null, state: "pending",
    }).onConflictDoUpdate({
      target: [schema.payrollSweepProposalsTable.payDate, schema.payrollSweepProposalsTable.rowKey],
      set: { runId, row: q.row as never, reason: q.reason, detail: q.detail, createdAt: new Date() },
    });
  }

  return { classified: settled.length, posted, queuedForReview: queued.length };
}

/** Close the run out — the Mac reports what happened, including failure. */
export async function finishSweep(
  runId: number,
  outcome: { ok: boolean; error?: string; counts?: Record<string, unknown> },
): Promise<void> {
  const existing = await db.select().from(schema.payrollSweepRunsTable)
    .where(eq(schema.payrollSweepRunsTable.id, runId)).limit(1);
  const prior = (existing[0]?.counts ?? {}) as Record<string, unknown>;
  await db.update(schema.payrollSweepRunsTable).set({
    status: outcome.ok ? "ok" : "failed",
    errMsg: outcome.error ?? null,
    counts: { ...prior, ...(outcome.counts ?? {}) },
    finishedAt: new Date(),
  }).where(eq(schema.payrollSweepRunsTable.id, runId));
  logger.info({ runId, ...outcome }, "payroll sweep run closed");
}
