/**
 * The faithfulness check for AI-written row labels — deliberately IMPORT-FREE.
 *
 * ⚠️ THIS IS THE POINT OF THE SUMMARY FEATURE, not the prompt. This is payroll:
 * a summary that drops a rate, a date, or a "do NOT" is worse than no summary.
 *
 * It lives in its own module with zero imports so it stays testable without a
 * database. Its home used to be payrollChangeSummary.ts, which is fine until
 * that file needs `db` — at which point a pure string test starts failing on
 * `DATABASE_URL is required`, which is exactly what happened on 2026-09-03.
 */

const MAX_LEN = 64;

const digitTokens = (text: string): string[] => text.match(/\d[\d,.:/-]*\d|\d/g) ?? [];

/** Digit-runs (rates, hours, dates) must survive VERBATIM — exact token
 *  membership, not substring: "20.5" hiding inside "20.50", or "1.5" inside
 *  "31.50", is precisely the corruption this exists to stop. Negation must
 *  not vanish either. */
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
