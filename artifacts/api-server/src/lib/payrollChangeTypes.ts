/**
 * The change-type taxonomy, and a normaliser for the drift.
 *
 * The `to do this payroll` ledger has been typed by hand every week for a year,
 * and across 22 workbooks it holds **130 distinct Type strings** that mean about
 * twenty-five things. "Housing Deductions Pro rate", "Housing Deductions Pro
 * Rate", "Housing deductions pro rate", "Housing Deducations pro rate" and
 * "Housing deduction pro rate" are one type written five ways; "Transportations
 * Deduction", "Transportation Deducations" and "&" for "and" are the same story.
 *
 * So the app offers a canonical list and normalises on the way in, while keeping
 * whatever was actually written. Reporting on the raw strings is what makes a
 * taxonomy look real while counting the same thing eleven times.
 */

export const CHANGE_TYPES = [
  "Housing Fringe",
  "Housing Deductions Start",
  "Housing Deductions Start and Pro Rate",
  "Housing Deductions Pro Rate",
  "Housing Deductions Stop",
  "Housing Deductions Update",
  "Transportation Deductions Start",
  "Transportation Deductions Start and Pro Rate",
  "Transportation Deductions Pro Rate",
  "Transportation Deductions Stop",
  "Transportation Deductions Suppress",
  "Housing and Transportation Deductions Start and Pro Rate",
  "Housing and Transportation Deductions Pro Rate",
  "Housing and Transportation Deductions Stop",
  "Retro Housing Deductions",
  "Retro Transportation Deductions",
  "Retro Housing Fringe",
  "Refund Housing Deductions",
  "Refund Transportation Deductions",
  "Refund Housing and Transportation Deductions",
  "MN ESST",
  "Holiday Pay",
  "Vacation Pay",
  "Special Pay Rate",
  "Pay Rate Increase",
  "Pay Rate Decrease",
  "Pay Rate Correction",
  "Bill Rate Change",
  "Retro Pay",
  "Retro Pay OT",
  "Retro Driver Pay",
  "Driver Adjustment",
  "Expense Reimbursement",
  "Expense Deduction",
  "Cell Phone Reimbursement",
  "ACH Reimbursement",
  "Bonus Referral",
  "Bonus Incentive",
  "Bonus",
  "Advance",
  "Advance Pay Back",
  "Direct Deposit Update",
  "Tax Update",
  "Pay No Bill",
  "Fringe",
  "Termination",
  "Other",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/**
 * Where in Zenople the change lands, and when relative to the timecard.
 *
 * PAS  — the payroll module, entered against the person.
 * TMS  — a transaction, entered before the timecard is built.
 * 2TMS — a transaction entered AFTER the timecard, on the second pass.
 *
 * Observed across all periods: 749 PAS, 554 2TMS, 240 TMS. The distinction
 * decides both where the work happens and what has to be re-verified.
 */
export const CHANGE_ROUTES = ["Ops", "TMS", "2TMS", "PAS"] as const;
export type ChangeRoute = (typeof CHANGE_ROUTES)[number];

/**
 * The order a processor works the board, which is the order of the week itself:
 * Zenople housekeeping before the Master export, transactions before Tuesday's
 * batch close (earnings AND billing at stake), the round-2 import, then the
 * Wednesday PAS run (check only, invoicing already done).
 */
export const ROUTE_ORDER: readonly ChangeRoute[] = ["Ops", "TMS", "2TMS", "PAS"];

/** When each route's work is due, phrased the way the checklist phrases it. */
export const DO_BY: Record<ChangeRoute, string> = {
  Ops: "Before the Master export — the Zenople file must be right first",
  TMS: "Mon–Tue, before transaction batches close — billing at risk",
  "2TMS": "Tue, with the round-2 import",
  PAS: "Wed, in the PAS payroll run",
};

/** Cheap fold so casing, punctuation and doubled spaces stop mattering. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Typos seen in the real data, repaired before matching.
 * `deducations`/`deducatoins` for deductions, `transportations`, `udpate`.
 */
const TYPO: Array<[RegExp, string]> = [
  [/deducations?/g, "deductions"],
  [/deducatoins?/g, "deductions"],
  [/transportations\b/g, "transportation"],
  [/udpate/g, "update"],
  [/\bprorate\b/g, "pro rate"],
  [/\bpro rated\b/g, "pro rate"],
];

const repair = (s: string): string =>
  TYPO.reduce((acc, [re, to]) => acc.replace(re, to), s);

/**
 * Ordered rules — FIRST match wins, so the most specific patterns come first.
 * "Housing and Transportation ... Stop" must beat plain "Housing ... Stop", and
 * "Start and Pro Rate" must beat both "Start" and "Pro Rate".
 */
const RULES: Array<[RegExp, ChangeType]> = [
  [/^retro housing fringe$|^retro housing fringe/, "Retro Housing Fringe"],
  [/^retro (housing and transportation|housing) /, "Retro Housing Deductions"],
  [/^retro housing$/, "Retro Housing Deductions"],
  [/^retro transportation/, "Retro Transportation Deductions"],
  [/^refund (housing and transportation|housing and transportation deductions)/, "Refund Housing and Transportation Deductions"],
  [/^refund housing/, "Refund Housing Deductions"],
  [/^refund transportation/, "Refund Transportation Deductions"],
  [/^refund advance/, "Advance Pay Back"],

  [/housing and transportation.*stop/, "Housing and Transportation Deductions Stop"],
  [/housing and transportation.*(start and pro rate|start)/, "Housing and Transportation Deductions Start and Pro Rate"],
  [/housing and transportation.*pro rate/, "Housing and Transportation Deductions Pro Rate"],

  [/housing (deduction|deductions).*(start and pro rate|start and prorate|start.*pro rate)/, "Housing Deductions Start and Pro Rate"],
  [/housing (deduction|deductions).*stop/, "Housing Deductions Stop"],
  [/housing (deduction|deductions).*(pro rate|double pro rate)/, "Housing Deductions Pro Rate"],
  [/housing (deduction|deductions).*(update|change|correction|split up)/, "Housing Deductions Update"],
  [/housing (deduction|deductions).*start/, "Housing Deductions Start"],
  [/^housing deductions$/, "Housing Deductions Update"],

  [/transportation.*suppress/, "Transportation Deductions Suppress"],
  [/transportation.*(start and pro rate|started and pro rate|start.*pro rate)/, "Transportation Deductions Start and Pro Rate"],
  [/transportation.*stop/, "Transportation Deductions Stop"],
  [/transportation.*pro rate/, "Transportation Deductions Pro Rate"],
  [/transportation.*start/, "Transportation Deductions Start"],

  [/housing (fringe|rebate fringe)/, "Housing Fringe"],
  [/^term(ination)?s?( |$)|terminated|assignment close|work state|residence state/, "Termination"],
  [/(^| )fringe( |$)/, "Fringe"],
  [/^mn esst$/, "MN ESST"],
  [/^holiday pay$/, "Holiday Pay"],
  [/^vacation pay$/, "Vacation Pay"],
  [/^special pay/, "Special Pay Rate"],

  [/pay rate.*(increase or decrease|correction)/, "Pay Rate Correction"],
  [/pay rate.*increase/, "Pay Rate Increase"],
  [/pay rate.*decrease/, "Pay Rate Decrease"],
  [/^bill rate/, "Bill Rate Change"],

  [/retro (pay )?(ot|pay ot)$|^retro pay ot/, "Retro Pay OT"],
  [/retro (driver pay|pay driver|driver)/, "Retro Driver Pay"],
  [/^retro pay/, "Retro Pay"],
  [/^driver (pay|time|hours adjustment)/, "Driver Adjustment"],

  [/expense reimbursement/, "Expense Reimbursement"],
  [/expense deduction/, "Expense Deduction"],
  [/cell phone reimbursement/, "Cell Phone Reimbursement"],
  [/ach reimbursement/, "ACH Reimbursement"],

  [/bonus referral|^bonus.*referral/, "Bonus Referral"],
  [/bonus incentive/, "Bonus Incentive"],
  [/^bonus/, "Bonus"],

  [/advance pay ?back|^advance payback/, "Advance Pay Back"],
  [/^advance$/, "Advance"],
  [/direct deposit update/, "Direct Deposit Update"],
  [/^tax (update|corrections?)/, "Tax Update"],
  [/^pay no bill$/, "Pay No Bill"],
];

/**
 * Best canonical type for a hand-typed string.
 *
 * Returns "Other" rather than guessing when nothing matches — an unrecognised
 * type should show up as unrecognised, not be quietly filed under whatever was
 * closest.
 */
export function normalizeChangeType(raw: string): ChangeType {
  const s = repair(fold(raw ?? ""));
  if (!s) return "Other";
  for (const [re, type] of RULES) if (re.test(s)) return type;
  return "Other";
}

/**
 * The four verification columns.
 *
 * ⚠️ The ledger writes one `x` PER PERSON on a row that covers several — 'xx',
 * 'xxx', 'xxxxx' all appear — so a checkbox is really a COUNT against however
 * many people the row names, not a boolean. Modelling it as a boolean would
 * silently mark a five-person row done when one person had been entered.
 */
export const VERIFICATION_FIELDS = [
  "enteredZenople", "verifiedTs", "verifiedPas", "documentationSaved",
] as const;
export type VerificationField = (typeof VERIFICATION_FIELDS)[number];

export type VerificationValue =
  | { kind: "not_applicable" }
  | { kind: "count"; done: number };

/** Parse a ledger cell: 'x' → 1, 'xxx' → 3, 'n/a' → not applicable, '' → 0. */
export function parseVerification(cell: string | null | undefined): VerificationValue {
  const s = (cell ?? "").trim().toLowerCase();
  if (!s) return { kind: "count", done: 0 };
  if (s === "n/a" || s === "na") return { kind: "not_applicable" };
  const xs = /^x+$/.exec(s);
  return xs ? { kind: "count", done: s.length } : { kind: "count", done: 0 };
}

/** Is this row fully verified for `people` people? */
export function isVerified(v: VerificationValue, people: number): boolean {
  return v.kind === "not_applicable" || v.done >= Math.max(1, people);
}

/**
 * Where each change type lands by default — Tiana's own "Pre or Post Time card"
 * column, learned from her ledgers rather than invented (749 PAS / 554 2TMS /
 * 240 TMS across every period), plus Brad's calls of 2026-09-01: MN ESST rides
 * the round-2 import, and terminations are their own Ops bucket because they
 * are Zenople housekeeping, not payroll transactions.
 *
 * ⚠️ THE REFUND RULE IS THE TRAP. Starting, stopping or pro-rating a deduction
 * is PAS — but REFUNDING one pushes money back to the employee, which runs on
 * the earnings side. Tiana files Acevedo/Cruz refunds as 2TMS in the same week
 * she files Russell/Cortez pro-rates as PAS. The taxonomy keeps refunds as
 * separate canonical types precisely so this map cannot mix them up.
 *
 * "Other" is deliberately null: an unrecognised change should surface as
 * "needs routing", never be quietly guessed into a stage.
 */
export const ROUTE_FOR: Record<ChangeType, ChangeRoute | null> = {
  // Earnings + billing — must beat Tuesday's batch close.
  "Special Pay Rate": "TMS",
  "Pay Rate Increase": "TMS",
  "Pay Rate Decrease": "TMS",
  "Pay Rate Correction": "TMS",
  "Bill Rate Change": "TMS",
  "Retro Pay": "TMS",
  "Retro Pay OT": "TMS",
  "Retro Driver Pay": "TMS",
  "Driver Adjustment": "TMS",
  "Pay No Bill": "TMS",

  // Earnings side, entered on the second pass after the timecard.
  "MN ESST": "2TMS",
  "Holiday Pay": "2TMS",
  "Vacation Pay": "2TMS",
  "Bonus": "2TMS",
  "Bonus Referral": "2TMS",
  "Bonus Incentive": "2TMS",
  "Expense Reimbursement": "2TMS",
  "Cell Phone Reimbursement": "2TMS",
  "ACH Reimbursement": "2TMS",
  "Refund Housing Deductions": "2TMS",
  "Refund Transportation Deductions": "2TMS",
  "Refund Housing and Transportation Deductions": "2TMS",
  "Housing Fringe": "2TMS",
  "Retro Housing Fringe": "2TMS",
  "Fringe": "2TMS",

  // Check only — Wednesday's PAS run, after invoicing.
  "Housing Deductions Start": "PAS",
  "Housing Deductions Start and Pro Rate": "PAS",
  "Housing Deductions Pro Rate": "PAS",
  "Housing Deductions Stop": "PAS",
  "Housing Deductions Update": "PAS",
  "Transportation Deductions Start": "PAS",
  "Transportation Deductions Start and Pro Rate": "PAS",
  "Transportation Deductions Pro Rate": "PAS",
  "Transportation Deductions Stop": "PAS",
  "Transportation Deductions Suppress": "PAS",
  "Housing and Transportation Deductions Start and Pro Rate": "PAS",
  "Housing and Transportation Deductions Pro Rate": "PAS",
  "Housing and Transportation Deductions Stop": "PAS",
  "Retro Housing Deductions": "PAS",
  "Retro Transportation Deductions": "PAS",
  "Expense Deduction": "PAS",
  "Advance": "PAS",
  "Advance Pay Back": "PAS",
  "Tax Update": "PAS",
  "Direct Deposit Update": "PAS",

  // Zenople housekeeping that must precede the Master export.
  "Termination": "Ops",

  // Unrecognised stays unrouted, loudly.
  "Other": null,
};

export function routeForChangeType(t: ChangeType): ChangeRoute | null {
  return ROUTE_FOR[t] ?? null;
}

/**
 * The Outlook category on the source thread, as a classifier PRIOR.
 *
 * Tiana tags most payroll threads herself; her tag is the starting point and
 * the email body sharpens it. An unnamed category ("Green Category" — the name
 * IS the colour) carries no meaning and seeds nothing, and an untagged thread
 * ("Terms and Job Changes" arrived with no tag at all) falls through to the
 * body alone. The seed NEVER overrides an explicit type or route — it only
 * fills what nothing else supplied.
 */
export function seedFromCategory(
  category: string | null | undefined,
): { changeType?: ChangeType; route: ChangeRoute } | null {
  const c = fold(category ?? "");
  if (!c || /^(red|orange|yellow|green|blue|purple) category$/.test(c)) return null;
  if (c === "pay rate change") return { route: "TMS" };
  if (c === "retro pay") return { changeType: "Retro Pay", route: "TMS" };
  if (c === "driver") return { changeType: "Driver Adjustment", route: "TMS" };
  if (c === "sick time") return { changeType: "MN ESST", route: "2TMS" };
  if (c === "transportation") return { route: "PAS" };
  if (c === "housing change" || c === "housing") return { route: "PAS" };
  if (c === "expense deduction") return { changeType: "Expense Deduction", route: "PAS" };
  return null;
}
