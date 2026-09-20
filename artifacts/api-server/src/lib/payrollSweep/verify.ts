/**
 * The gate that decides whether a swept row posts to the board or waits for a
 * human. Import-free on purpose so it stays testable without a database — the
 * same reason `payrollSummaryFaithful.ts` lives alone.
 *
 * ⚠️ THIS IS THE POINT OF THE WHOLE FEATURE, not the prompt. A nightly job that
 * writes payroll instructions nobody asked for is worse than no job at all. The
 * model may read an email and paraphrase it; what it may NOT do is produce a
 * number that is not in the email. So every figure on a row has to be found in
 * the source text before the row is allowed onto Tiana's queue.
 */

/** Numbers as written: 1,250.00 · 20.50 · 8 · 85.99 */
const NUM = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Compare numerically, not as strings — the model legitimately writes "$100.00"
 * for an email's "$100", and rejecting that would queue nearly every row. What
 * this still catches is the corruption that matters: 185.99 when the email says
 * 85.99, or 20.5 hiding inside 31.50.
 */
function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.match(NUM) ?? []) {
    const n = Number(m.replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/**
 * Every way a human writes 2026-09-12 in an email: 9/12, 09/12, 9/12/26,
 * 9/12/2026, 9-12, Sep 12, September 12, and the ISO form itself.
 *
 * ⚠️ Dates cannot go through the numeric check. "2026-09-12" tokenises as one
 * run and appears verbatim in essentially no email ever written, so a naive
 * digit check would reject every dated row — which is all of them.
 */
function dateAppearsIn(text: string, iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return true; // not a date we can reason about — don't block on it
  const [, y, mo, d] = m;
  const mon = Number(mo);
  const day = Number(d);
  const yy = y.slice(2);
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december"];
  const name = MONTHS[mon - 1] ?? "";
  const hay = text.toLowerCase();
  const forms = [
    iso,
    `${mon}/${day}`, `${mo}/${d}`,
    `${mon}/${day}/${y}`, `${mo}/${d}/${y}`,
    `${mon}/${day}/${yy}`, `${mo}/${d}/${yy}`,
    `${mon}-${day}`, `${mo}-${d}`,
    `${mon}.${day}`, `${mo}.${d}`,
    `${name} ${day}`, `${name.slice(0, 3)} ${day}`,
    `${day} ${name}`,
  ];
  return forms.some((f) => f && hay.includes(f.toLowerCase()));
}

export type CandidateRow = {
  action: string;
  amount?: number | null;
  hours?: number | null;
  weekEnding?: string | null;
  effectiveDate?: string | null;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "unverified"; detail: string };

/**
 * Is every figure on this row actually present in the email it came from?
 */
export function rowIsFaithful(row: CandidateRow, sourceText: string): VerifyResult {
  const present = numbersIn(sourceText);
  const missing: string[] = [];

  if (row.amount != null && !present.has(row.amount)) {
    missing.push(`amount ${row.amount}`);
  }
  if (row.hours != null && !present.has(row.hours)) {
    missing.push(`hours ${row.hours}`);
  }
  for (const [label, iso] of [
    ["weekEnding", row.weekEnding],
    ["effectiveDate", row.effectiveDate],
  ] as const) {
    if (iso && !dateAppearsIn(sourceText, iso)) missing.push(`${label} ${iso}`);
  }

  // Numbers the model wrote into the instruction text itself. Dates inside the
  // action are skipped here — they are prose ("eff 9/11") and already covered
  // by the effectiveDate/weekEnding checks above when they matter.
  const actionNumbers = numbersIn(stripDates(row.action));
  for (const n of actionNumbers) {
    // Year-like and small counts are noise ("2026", "3 people", "1 of 2").
    if (n >= 1900 && n <= 2100) continue;
    if (Number.isInteger(n) && n <= 12) continue;
    if (!present.has(n)) missing.push(`"${n}" in the instruction`);
  }

  if (missing.length) {
    return {
      ok: false,
      reason: "unverified",
      detail: `not found in the source email: ${missing.join(", ")}`,
    };
  }
  return { ok: true };
}

/** Remove date-shaped runs so they don't get numeric-checked as quantities. */
function stripDates(s: string): string {
  return s
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ");
}

/**
 * Fields whose movement is worth telling a human about. Mirrors MATERIAL in
 * `payrollChangeMerge.ts` — kept as its own list because this module must not
 * import anything, and duplicated deliberately rather than loosened.
 */
export const MATERIAL_FIELDS = [
  "amount", "hours", "effectiveDate", "weekEnding", "action", "route",
  "changeType", "peopleCount",
] as const;

export type TouchedCheck = {
  enteredZenople: number;
  verifiedTs: number;
  verifiedPas: number;
  documentationSaved: number;
};

/** Has a person put any mark against this row yet? (-1 means "n/a" — a choice.) */
export function humanHasTouched(r: TouchedCheck): boolean {
  return (
    r.enteredZenople !== 0 || r.verifiedTs !== 0 ||
    r.verifiedPas !== 0 || r.documentationSaved !== 0
  );
}

/**
 * Would posting `swept` move a material field on a row someone already ticked?
 *
 * ⚠️ THE MERGE CANNOT SEE THIS. `mergeRow` faithfully protects the four counts
 * and the notes — the fields the human OWNS. It does not protect her
 * CONFIDENCE: it will happily rewrite `amount` underneath a row she has already
 * checked off, and nothing on the board would tell her the number moved after
 * she verified it. On a payroll ledger that is the worst failure available, so
 * these rows go to review instead of being written.
 */
type MaterialShape = Partial<Record<(typeof MATERIAL_FIELDS)[number], unknown>>;

export function wouldDisturbVerified(
  swept: MaterialShape,
  stored: (MaterialShape & TouchedCheck) | undefined,
): { ok: true } | { ok: false; reason: "would_change_verified"; detail: string } {
  if (!stored || !humanHasTouched(stored)) return { ok: true };
  const moved: string[] = [];
  for (const f of MATERIAL_FIELDS) {
    const before = stored[f];
    const after = swept[f];
    if (after === undefined) continue;
    if (before == null && after == null) continue;
    if (before !== after) moved.push(`${f}: ${fmt(before)} → ${fmt(after)}`);
  }
  if (!moved.length) return { ok: true };
  return {
    ok: false,
    reason: "would_change_verified",
    detail: `already verified; the sweep would change ${moved.join("; ")}`,
  };
}

const fmt = (v: unknown): string => (v === null || v === undefined ? "blank" : String(v));
