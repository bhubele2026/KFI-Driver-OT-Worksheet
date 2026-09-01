import { createHash } from "node:crypto";
import { getClaudeClient } from "./parsers/claude.js";
import { logger } from "./logger.js";

/**
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
const MAX_LEN = 64;
/** Real limit for a model call — generous, because it runs in the background. */
const TIMEOUT_MS = 60_000;
/** How long a board response will WAIT for summaries. A warm cache answers
 *  instantly; a cold one fills in the background and the NEXT load has them.
 *  The first deploy blocked the whole GET on a 15s model timeout — the board
 *  sat on skeletons and still rendered wordy. Never block the board. */
const SOFT_WAIT_MS = 3_500;
/** Rows per model call — three short calls beat one long one under a wait. */
const CHUNK = 16;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Action-hashes currently being summarized, so overlapping board loads never
 *  double-spend a call on the same rows. */
const inflightKeys = new Set<string>();

/** sha1(action) → summary. Keyed on the TEXT, so a re-swept row that changed
 *  its action re-summarizes and an unchanged one never pays twice. */
const cache = new Map<string, string>();
const keyFor = (action: string): string =>
  createHash("sha1").update(action).digest("hex");

const digitTokens = (text: string): string[] => text.match(/\d[\d,.:/-]*\d|\d/g) ?? [];

/** Digit-runs (rates, hours, dates) must survive VERBATIM — exact token
 *  membership, not substring: "20.5" hiding inside "20.50", or "1.5" inside
 *  "31.50", is precisely the corruption this exists to stop. Negation must
 *  not vanish either. Exported for tests. */
export function summaryIsFaithful(action: string, summary: string): boolean {
  if (!summary || summary.length > MAX_LEN + 16) return false;
  const allowed = new Set(digitTokens(action));
  for (const t of digitTokens(summary)) {
    if (!allowed.has(t)) return false;
  }
  const negated = /\b(not|never|don'?t|no)\b/i;
  if (negated.test(action) && !negated.test(summary)) return false;
  return true;
}

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
    for (const r of chunk) {
      const raw = parsed[r.rowKey];
      const summary =
        typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
      if (summary && summaryIsFaithful(r.action, summary)) {
        cache.set(keyFor(r.action), summary);
      } else {
        // Cache the refusal too — an unfaithful summary would be regenerated
        // (and re-rejected) on every single board load otherwise.
        cache.set(keyFor(r.action), "");
      }
    }
  } catch (err) {
    // No key, timeout, refusal, bad JSON — those rows show full text; a later
    // load retries them (nothing cached on a transport failure, on purpose).
    logger.warn({ err, chunk: chunk.length }, "change summaries unavailable");
  }
}

/** Summaries for the given rows — cache hits immediately, everything else
 *  from chunked background calls this response waits on only briefly.
 *  Always resolves; failures just resolve smaller. */
export async function summarizeChangeActions(
  rows: SummarizableRow[],
): Promise<Map<string, string>> {
  const pending: SummarizableRow[] = [];
  for (const r of rows) {
    const k = keyFor(r.action);
    if (cache.get(k) === undefined && !inflightKeys.has(k)) pending.push(r);
  }

  if (pending.length) {
    for (const r of pending) inflightKeys.add(keyFor(r.action));
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < pending.length; i += CHUNK) {
      jobs.push(runChunk(pending.slice(i, i + CHUNK)));
    }
    const all = Promise.allSettled(jobs).then(() => {
      for (const r of pending) inflightKeys.delete(keyFor(r.action));
    });
    // Wait briefly: a warm model lands inside this window and the response
    // carries summaries; a cold one keeps filling the cache after we return.
    await Promise.race([all, sleep(SOFT_WAIT_MS)]);
  }

  const out = new Map<string, string>();
  for (const r of rows) {
    const hit = cache.get(keyFor(r.action));
    if (hit) out.set(r.rowKey, hit);
  }
  return out;
}
