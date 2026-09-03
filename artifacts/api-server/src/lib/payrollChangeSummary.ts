import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
// ⚠️ `db` AND `schema` both come from ./db.js — never `import * as schema from
// "@workspace/db"`. That root export builds a SECOND pg.Pool at module scope
// from the RAW DATABASE_URL, which (a) makes this module throw without a
// database, breaking the pure summaryIsFaithful test, and (b) skips the
// sslmode strip in db.ts that exists to stop pg>=8.16's SECURITY WARNING being
// filed as a Sentry error on every boot.
import { db, schema } from "./db.js";
import { summaryIsFaithful } from "./payrollSummaryFaithful.js";
import { getClaudeClient } from "./parsers/claude.js";
import { logger } from "./logger.js";

/**
 * ⚠️ THE BOARD NEVER WAITS FOR THE MODEL. There is no soft-wait here any more.
 *
 * It used to `await Promise.race([all, sleep(3_500)])`. Measured against
 * production on 2026-09-03: a cold period took 3,594ms and came back with ZERO
 * summaries; the very next load took 52ms and had all of them. The wait cost
 * the user 3.5 seconds and bought them nothing — the model work finishes
 * moments later either way. The old comment already said "never block the
 * board"; now the code agrees. Cold rows return absent and the client fills
 * them in on a short backoff. If you are tempted to await this again: make the
 * summary arrive sooner, do not make the board arrive later.
 *
 * Terse row labels for the Changes board — Brad: "too many words, use AI to
 * summarize." One batched call per period load, cached in-process per action
 * text (the app is pinned to a single replica), and NEVER load-bearing: a
 * missing key, a timeout, or a summary that flunks the faithfulness check
 * just leaves that row showing its full action text.
 *
 * ⚠️ THE FAITHFULNESS CHECK IS THE POINT, not the prompt. This is payroll:
 * a summary that drops a rate, a date, or a "do NOT" is worse than no
 * summary. Every digit-run in a summary must appear verbatim in its source,
 * and a negated source must stay negated. Anything else falls back.
 */

export type SummarizableRow = {
  rowKey: string;
  changeType: string;
  employee: string | null;
  action: string;
};

const MODEL = process.env.CLAUDE_SUMMARY_MODEL ?? "claude-haiku-4-5-20251001";
/** Real limit for a model call — generous, because it runs in the background. */
const TIMEOUT_MS = 60_000;
/** Rows per model call. */
const CHUNK = 16;
/** Chunks in flight at once. Nothing waits on these now, so there is no reason
 *  to fan 200 rows out into ~13 simultaneous calls and invite 429s. */
const MAX_PARALLEL_CHUNKS = 3;

/** Action-hashes currently being summarized, so overlapping board loads never
 *  double-spend a call on the same rows. */
const inflightKeys = new Set<string>();

/** sha1(action) → summary. Keyed on the TEXT, so a re-swept row that changed
 *  its action re-summarizes and an unchanged one never pays twice. */
const cache = new Map<string, string>();
const keyFor = (action: string): string =>
  createHash("sha1").update(action).digest("hex");

// The faithfulness check lives in its own import-free module so it stays
// testable without a database — this file needs `db` now. Re-exported so
// existing importers (and the test) keep working either way.
export { summaryIsFaithful } from "./payrollSummaryFaithful.js";

const RULES = `You compress payroll instructions into terse row labels for a board a payroll
specialist works down. For each input row return ONE imperative label.

Rules, in order:
- ≤ 48 characters. Imperative voice ("Enter…", "Revert…", "Close…").
- Copy every number, rate, hour figure and date EXACTLY as written in the
  source — never reformat, round, or invent one.
- If the source says NOT to do something, the label must keep the negation.
- Drop the explanation, keep the act. "Term AND fix the Zenople address —
  still shows NY residency, which breaks state withholding" → "Term + fix NY
  address in Zenople".
- Plain text only. No trailing period.

Input: a JSON array of {rowKey, changeType, employee, action}.
Output: ONLY a JSON object mapping every rowKey to its label. No other text.`;

/** One model call over ≤CHUNK rows; writes the cache, returns nothing. */
async function runChunk(chunk: SummarizableRow[]): Promise<void> {
  try {
    const client = getClaudeClient();
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 2048,
        system: RULES,
        messages: [{ role: "user", content: JSON.stringify(chunk) }],
      },
      { timeout: TIMEOUT_MS },
    );
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const durable: { actionHash: string; summary: string; model: string }[] = [];
    for (const r of chunk) {
      const raw = parsed[r.rowKey];
      const summary =
        typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
      if (summary && summaryIsFaithful(r.action, summary)) {
        cache.set(keyFor(r.action), summary);
        durable.push({ actionHash: keyFor(r.action), summary, model: MODEL });
      } else {
        // Cache the refusal too — an unfaithful summary would be regenerated
        // (and re-rejected) on every single board load otherwise.
        cache.set(keyFor(r.action), "");
      }
    }
    // One batched upsert per chunk (<=16 rows) — never a per-row loop. A write
    // failure must not lose the summaries we just computed, so it only warns:
    // the in-process cache still has them for this process's lifetime.
    if (durable.length) {
      try {
        await db.insert(schema.payrollChangeSummaryTable).values(durable)
          .onConflictDoNothing();
      } catch (err) {
        logger.warn({ err, rows: durable.length }, "change summaries not persisted");
      }
    }
  } catch (err) {
    // No key, timeout, refusal, bad JSON — those rows show full text; a later
    // load retries them (nothing cached on a transport failure, on purpose).
    logger.warn({ err, chunk: chunk.length }, "change summaries unavailable");
  }
}

/** Load any summaries we already computed in a previous life (or a previous
 *  deploy) into the in-process cache. One indexed lookup on a primary key over
 *  the hashes this request actually needs. */
async function hydrateFromStore(hashes: string[]): Promise<void> {
  // ⚠️ FALSY, not `undefined`. A row this process refused is cached as "" — and
  // if we skipped those, a replica could never learn that a SIBLING replica
  // summarized the same action text successfully and persisted it. That is not
  // hypothetical: with minReplicas=2, period 2026-09-04 sat at 34 summaries on
  // one replica and 41 on the other, so the label on a row appeared and
  // disappeared as you reloaded, forever, with nothing outstanding to explain
  // it. Re-reading a refusal costs one indexed PK lookup and it is what makes
  // the two replicas converge.
  const missing = hashes.filter((h) => !cache.get(h));
  if (!missing.length) return;
  try {
    const rows = await db
      .select({
        actionHash: schema.payrollChangeSummaryTable.actionHash,
        summary: schema.payrollChangeSummaryTable.summary,
      })
      .from(schema.payrollChangeSummaryTable)
      .where(inArray(schema.payrollChangeSummaryTable.actionHash, missing));
    for (const r of rows) cache.set(r.actionHash, r.summary);
  } catch (err) {
    // The board does not depend on this. A read failure just means some rows
    // get re-summarized in the background — never a slower or broken response.
    logger.warn({ err }, "change summary store unreadable");
  }
}

/** Summaries for the given rows. Returns whatever is KNOWN RIGHT NOW and kicks
 *  off background work for the rest — it never waits on the model.
 *
 *  Rows with no summary yet come back absent, render as their full action text,
 *  and the client picks up the labels on a short backoff. Always resolves.
 *
 *  `pending` is how many rows were just queued for background work. The client
 *  needs this to know when to STOP re-asking: it cannot infer "everything that
 *  will arrive has arrived" from the data, because a row whose summary flunked
 *  the faithfulness check is cached as "" and correctly never gets a label.
 *  Period 2026-09-04 sits at 36 summaries of 45 rows permanently — a client
 *  waiting for all 45 would re-fetch on every single page view, forever. */
export async function summarizeChangeActions(
  rows: SummarizableRow[],
): Promise<{ summaries: Map<string, string>; pending: number }> {
  await hydrateFromStore([...new Set(rows.map((r) => keyFor(r.action)))]);

  // Dedupe by action hash: two rows with byte-identical action text are ONE
  // unit of work. Without this both enter `pending`, we pay the model twice for
  // the same string, and if they land in different chunks the first chunk's
  // cleanup deletes the shared inflight key while the second is still running.
  const seen = new Set<string>();
  const pending: SummarizableRow[] = [];
  for (const r of rows) {
    const k = keyFor(r.action);
    if (cache.get(k) === undefined && !inflightKeys.has(k) && !seen.has(k)) {
      seen.add(k);
      pending.push(r);
    }
  }

  if (pending.length) {
    for (const r of pending) inflightKeys.add(keyFor(r.action));
    const chunks: SummarizableRow[][] = [];
    for (let i = 0; i < pending.length; i += CHUNK) {
      chunks.push(pending.slice(i, i + CHUNK));
    }
    // Fire and forget, at a bounded concurrency.
    //
    // ⚠️ Each chunk releases ITS OWN keys as it settles. This used to clear
    // every key only after all chunks settled, so one chunk crawling toward
    // TIMEOUT_MS (60s) kept unrelated rows marked in-flight — and every board
    // load for the next minute returned no summaries and never retried them.
    void (async () => {
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < chunks.length) {
          const chunk = chunks[next++]!;
          try {
            await runChunk(chunk);
          } finally {
            for (const r of chunk) inflightKeys.delete(keyFor(r.action));
          }
        }
      };
      await Promise.allSettled(
        Array.from({ length: Math.min(MAX_PARALLEL_CHUNKS, chunks.length) }, worker),
      );
    })();
  }

  const out = new Map<string, string>();
  for (const r of rows) {
    const hit = cache.get(keyFor(r.action));
    if (hit) out.set(r.rowKey, hit);
  }
  return { summaries: out, pending: pending.length };
}
