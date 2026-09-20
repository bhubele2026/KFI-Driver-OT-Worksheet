import { createHash } from "node:crypto";
import type { MailHeader } from "./graphMail.js";

/**
 * The cheap, deterministic first pass over mail headers.
 *
 * ⚠️⚠️ THIS FILTER IS BIASED TOWARD RECALL AND MUST STAY THAT WAY. It drops
 * only mail that is unambiguously machine-generated. Everything else goes to
 * the model, because the 2026-09-16 sweep proved a subject-keyword filter
 * loses real money:
 *
 *  - "Timesheets week of 9-7-26" from a customer looks exactly like a routine
 *    timesheet submission. It carried the Labor Day holiday-pay list.
 *  - "Re: Trienda's KFI Pay Summary W/E 9/12/2026" looks like a routine pay
 *    summary. It carried the safety bonus.
 *
 * Both were rescued only because Tiana had tagged them in Outlook. Hence the
 * hard rule below: A CATEGORY ALWAYS OVERRIDES A SKIP.
 *
 * And the highest-yield pattern of all is invisible to keywords — 9 of the 59
 * real candidates had a bare person's name as the entire subject ("David
 * Arroyo", "RE: Cruz Sanchez"). The load-bearing signal is the sender and the
 * fact it was sent to payroll@, not the words in the subject.
 */

/** Senders that never carry a payroll instruction a human wrote. */
const MACHINE_SENDER = [
  /@zenople\./i,
  /^no-?reply@/i,
  /^donot-?reply@/i,
  /^postmaster@/i,
  /@asure\./i,
  /@rapid(financial|paycard)?\./i,
  /@jjkeller\./i,
  /@ssa\.gov$/i,
  /@iwd\.iowa\.gov$/i,
  /@michigan\.gov$/i,
  /@.*\.state\.[a-z]{2}\.us$/i,
  /mailer-daemon/i,
];

/** Subjects that are always automated notices, regardless of sender. */
const MACHINE_SUBJECT = [
  /^\[postmaster\]/i,
  /^undeliverable\b/i,
  /^automatic reply\b/i,
  /^out of office\b/i,
  /^invoice report for /i,
  /^assignments? ended\b/i,
  /^new assignments?\b/i,
  /^your .*(statement|verification code)\b/i,
];

export type Verdict = {
  keep: boolean;
  /** Why — recorded on the seen-message row so a run log can explain itself. */
  reason: string;
};

export function prefilterVerdict(h: MailHeader): Verdict {
  // ⚠️ Tiana's own tag beats every rule below. She categorises threads as she
  // triages them, and a tagged thread is by definition one she considers
  // payroll-relevant. A "Cancelled Change" tag still comes through — it must be
  // CLASSIFIED (so the run can report it) and then not posted, which is a
  // decision for the classifier, not something to silently drop here.
  const tagged = h.categories.filter((c) => !isColourOnly(c));
  if (tagged.length > 0) return { keep: true, reason: `categorised: ${tagged.join(";")}` };

  for (const re of MACHINE_SENDER) {
    if (re.test(h.from)) return { keep: false, reason: `machine sender ${h.from}` };
  }
  for (const re of MACHINE_SUBJECT) {
    if (re.test(h.subject)) return { keep: false, reason: "automated notice" };
  }
  // Calendar noise and read receipts carry no instruction.
  if (/^(accepted|declined|tentative|canceled|cancelled):/i.test(h.subject)) {
    return { keep: false, reason: "calendar response" };
  }
  if (!h.subject.trim() && !h.bodyPreview.trim()) {
    return { keep: false, reason: "empty message" };
  }
  return { keep: true, reason: "candidate" };
}

/** "Green Category" names a colour, not a meaning — it seeds nothing. */
function isColourOnly(c: string): boolean {
  return /^(red|orange|yellow|green|blue|purple)\s+category$/i.test(c.trim());
}

/**
 * Collapse the folder duplicates Graph returns.
 *
 * ⚠️ Dedupe on internetMessageId, NEVER on the Graph id. A mailbox-wide query
 * returns the same message once per folder it has been copied into, and the
 * Graph id differs in each — the 09.16 run pulled 362 header rows for far
 * fewer real messages. Keeps the most recently received copy, which is the one
 * whose Graph id is most likely to still resolve.
 */
export function dedupeHeaders(headers: MailHeader[]): MailHeader[] {
  const byId = new Map<string, MailHeader>();
  for (const h of headers) {
    const prev = byId.get(h.internetMessageId);
    if (!prev || h.receivedAt > prev.receivedAt) byId.set(h.internetMessageId, h);
  }
  return [...byId.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/** Body fingerprint, so an unchanged thread is not re-classified nightly. */
export function bodyHash(text: string): string {
  return createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}
