import { getClaudeClient } from "../parsers/claude.js";
import { logger } from "../logger.js";
import { CHANGE_TYPES } from "../payrollChangeTypes.js";
import type { MailBody, MailHeader } from "./graphMail.js";
import type { ClassifiedAction } from "./buildRows.js";

/**
 * The judgment that used to live in a Claude session, written down.
 *
 * Two passes, because they have different jobs and different costs:
 *   TRIAGE   — cheap, recall-biased, reads only headers. Its job is to not
 *              throw away a real change; a false keep costs one classify call.
 *   CLASSIFY — the expensive one, reads the full body with its quoted history
 *              and produces action rows.
 *
 * ⚠️ NOTHING HERE IS LOAD-BEARING FOR THE BOARD. Every failure path returns
 * empty and logs — a dead model, a timeout, a malformed response. The board
 * renders from the database, and a sweep that produced nothing must look like
 * a sweep that produced nothing, never like an error page.
 */

const TRIAGE_MODEL = process.env.PAYROLL_SWEEP_TRIAGE_MODEL ?? "claude-haiku-4-5-20251001";
const CLASSIFY_MODEL = process.env.PAYROLL_SWEEP_CLASSIFY_MODEL ?? "claude-sonnet-5";
const TIMEOUT_MS = 120_000;
/** Nothing waits on these, so concurrency is about being a good Graph/API citizen. */
export const MAX_PARALLEL = 3;

/**
 * The eight judgment rules, as learned from a year of Tiana's ledgers and a
 * full hand-run. These are the deliverable — the schema is just plumbing.
 */
const RULES = `You read payroll email for KFI Staffing and turn it into ACTION ROWS that a
payroll specialist will key into Zenople before the pay date.

THE EIGHT RULES, in order of importance:

1. TAKE THE LAST REPLY'S NUMBER, and say what it replaced. These threads are
   full of corrections: two people were requested at 8 hrs sick time and
   corrected to 10 the next day. Someone reading top-down keys 8. Put the final
   number in the row and the story in "supersedes".
2. ONE ROW PER ACTION, not per email. Three people named in one transportation
   table are three rows. A thread corrected four times is ONE row carrying the
   final number.
3. SPLIT RETRO FROM THE CURRENT WEEK. Hours booked to a prior week are their
   own row with that week's "weekEnding". Never merge two weeks into one row.
4. PAIRED ROWS MUST NAME EACH OTHER. A stop and its refund, a rate change and
   its retro, a +2.00 OT and its -0.50 correction: entering one alone overpays
   or underpays. Use "pairedWith" with the other row's ref, on BOTH rows.
5. ANSWER ONLY THE QUESTION ASKED. A transportation waiver is not a housing
   waiver. If the email stops one deduction, do not touch the other.
6. A DISCUSSED INTENT IS NOT AN APPROVAL. If the thread is still a question —
   nobody said "approved", or the person it affects was never told — set
   needsDecision:true with a decisionQuestion and a decisionOwner. Do NOT
   write it as an action.
7. CROSS-FOOT. Your numbers must reproduce the source. If the email says three
   people at $100 each, the rows total $300.
8. SCAN FOR REVERSALS. A change already keyed can still need undoing — a raise
   entered, then declined a week later, is an ACTION to revert it, not a note.

HARD CONSTRAINTS:

- AMOUNT IS REAL DOLLARS ONLY — advances, reimbursements, gross-ups, weekly
  deduction amounts. A PAY RATE IS NOT AN AMOUNT. "$21.65/hr" goes in the
  action text and amount stays null.
- NEVER INVENT A NUMBER OR A DATE. Every figure you write must appear in the
  email. If a number is implied but not stated, say so in the action text
  instead of computing one.
- Dates are YYYY-MM-DD. weekEnding is the SATURDAY the hours belong to.
- "Please disregard" / "ignore my last" retracts what it replies to.
- If the thread is tagged "Cancelled Change", return rows:[] and say so in
  "note" — the change was pulled and must not be keyed.
- Informational mail produces NO rows: attendance, no-shows, schedules, court
  dates, billing-only discussions, and anything already confirmed as done.
- An action is an IMPERATIVE instruction to the processor: "Stop transportation
  deduction eff 9/11 — do NOT touch housing", not "transportation question".`;

const OUTPUT_CONTRACT = `Return ONLY a JSON object:
{"note": string, "rows": [ { ... } ]}

Each row:
  ref            short slug unique within this email, e.g. "payne-advance"
  payDate        YYYY-MM-DD, the Friday this should be paid on
  customer       customer short name, or null if the email never says
  employee       "First Last", or "Multiple (n)" for a genuinely bulk row
  peopleCount    integer, default 1
  changeType     EXACTLY one of the canonical types listed below
  route          omit unless the type's default routing is wrong
  amount         number or null — DOLLARS ONLY, never a pay rate
  hours          number or null
  weekEnding     YYYY-MM-DD (the Saturday) or null
  effectiveDate  YYYY-MM-DD or null
  action         the imperative instruction, including any rate
  supersedes     what the final number replaced, or null
  pairedWith     another row's ref, or null
  requestedBy    who asked, or null
  approvedBy     who approved, or null
  needsDecision  true ONLY when it is still a question
  decisionQuestion / decisionOwner  required when needsDecision is true
  keySuffix      set only to separate two same-type rows for one person in one
                 week (e.g. the amount)

Do not output conversation ids, message ids, categories or row keys — those are
supplied from the message itself. No prose, no markdown fences.`;

function canonicalTypes(): string {
  return CHANGE_TYPES.filter((t) => t !== "Other").join("\n");
}

/** Strip fences and pull the first balanced JSON object out of a reply. */
function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)) as T; }
        catch { return null; }
      }
    }
  }
  return null;
}

async function ask(model: string, system: string, user: string, maxTokens: number): Promise<string> {
  const client = getClaudeClient();
  const stream = client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      // Mechanical reading, not deliberation — the same setting the customer
      // file extractor uses, for the same reason: adaptive thinking burns the
      // output budget and truncates the JSON.
      thinking: { type: "disabled" },
      system,
      messages: [{ role: "user", content: user }],
    },
    { timeout: TIMEOUT_MS },
  );
  const res = await stream.finalMessage();
  // Narrow on the discriminant rather than asserting a shape: the SDK's
  // TextBlock carries fields (citations) a hand-written predicate omits, and
  // the union also holds thinking blocks that have no `text` at all.
  const parts: string[] = [];
  for (const block of res.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
}

export type TriageVerdict = { internetMessageId: string; keep: boolean; why: string };

/**
 * Header-only keep/drop over a batch.
 *
 * ⚠️ Biased hard toward keeping. The 09.16 run showed the highest-yield
 * pattern is a bare person's name as the whole subject ("David Arroyo") — no
 * keyword, no tag, and a real transportation change inside. A false keep costs
 * one classify call; a false drop costs somebody their pay.
 */
export async function triage(headers: MailHeader[]): Promise<TriageVerdict[]> {
  if (headers.length === 0) return [];
  const input = headers.map((h) => ({
    id: h.internetMessageId,
    subject: h.subject,
    from: h.from,
    to: h.to.join(", "),
    categories: h.categories,
    preview: h.bodyPreview.slice(0, 400),
  }));

  const system = `You triage the payroll mailbox for KFI Staffing. For each message decide
whether it MIGHT contain a payroll change that must be keyed before payday.

KEEP anything that could affect someone's pay or deductions: rates, hours,
sick time, holiday pay, bonuses, advances, reimbursements, housing or
transportation deductions, refunds, terminations, job or address changes,
direct deposit, tax.

KEEP when a person's name is the subject with no other clue — that is the most
common shape of a real change in this mailbox.
KEEP anything a human at KFI wrote to payroll@ that reads like an instruction,
a question about someone's pay, or an answer to one.
KEEP anything with an Outlook category set by the payroll specialist.

DROP only what is unambiguously routine: bulk timesheet or punch submissions
with no individual instruction, automated reports, invoices and statements,
system notices, newsletters, and calendar traffic.

WHEN IN DOUBT, KEEP. A wrong drop silently loses someone's pay; a wrong keep
costs one cheap read.

Return ONLY {"verdicts":[{"id": string, "keep": boolean, "why": string}]}`;

  try {
    const text = await ask(TRIAGE_MODEL, system, JSON.stringify(input), 4096);
    // The model is asked for `id`; accept either spelling rather than cast.
    type RawVerdict = { id?: string; internetMessageId?: string; keep?: boolean; why?: string };
    const parsed = parseJson<{ verdicts?: RawVerdict[] }>(text);
    const byId = new Map<string, RawVerdict>();
    for (const v of parsed?.verdicts ?? []) {
      const key = v.internetMessageId ?? v.id;
      if (key) byId.set(key, v);
    }
    return headers.map((h) => {
      const v = byId.get(h.internetMessageId);
      // ⚠️ Unknown means KEEP. A message the model forgot to mention must not
      // fall through the floor.
      return {
        internetMessageId: h.internetMessageId,
        keep: v?.keep !== false,
        why: v?.why ?? "no verdict returned — kept by default",
      };
    });
  } catch (err) {
    logger.warn({ err, count: headers.length }, "payroll sweep triage failed — keeping all");
    return headers.map((h) => ({
      internetMessageId: h.internetMessageId,
      keep: true,
      why: "triage unavailable — kept by default",
    }));
  }
}

export type ClassifyResult = { rows: ClassifiedAction[]; note: string };

/** Full-body classification of one message into action rows. */
export async function classifyMessage(
  msg: MailBody,
  ctx: { openPayDate: string; todayIso: string },
): Promise<ClassifyResult> {
  const system = `${RULES}

CANONICAL CHANGE TYPES — use one of these EXACTLY:
${canonicalTypes()}

${OUTPUT_CONTRACT}`;

  const user = [
    `Today is ${ctx.todayIso}. The open pay date is ${ctx.openPayDate}.`,
    `A change effective on or after the next period, or one the sender asks to`,
    `hold for "next check", belongs on a LATER Friday — set payDate accordingly.`,
    ``,
    `Subject: ${msg.subject}`,
    `From: ${msg.fromName} <${msg.from}>`,
    `To: ${msg.to.join(", ")}`,
    `Received: ${msg.receivedAt}`,
    `Outlook categories: ${msg.categories.join("; ") || "(none)"}`,
    `Attachments: ${msg.attachmentNames.join("; ") || "none"}`,
    ``,
    `--- message body, including quoted history ---`,
    msg.text.slice(0, 60_000),
  ].join("\n");

  try {
    const text = await ask(CLASSIFY_MODEL, system, user, 8192);
    const parsed = parseJson<{ rows?: ClassifiedAction[]; note?: string }>(text);
    if (!parsed) {
      logger.warn({ subject: msg.subject }, "payroll sweep: unparseable classify reply");
      return { rows: [], note: "the classifier reply could not be parsed" };
    }
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    // Refuse anything without the two fields the ledger cannot do without.
    const usable = rows.filter((r) => r && typeof r.action === "string" && typeof r.changeType === "string");
    return { rows: usable, note: parsed.note ?? "" };
  } catch (err) {
    logger.warn({ err, subject: msg.subject }, "payroll sweep: classify failed");
    return { rows: [], note: "classification failed" };
  }
}

/** Run `work` over `items` with a bounded number in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!);
    }
  });
  await Promise.all(runners);
  return out;
}
