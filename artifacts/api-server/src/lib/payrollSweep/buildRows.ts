import { rowKeyFor, type SweptRow } from "../payrollChangeMerge.js";
import {
  CHANGE_ROUTES, normalizeChangeType, routeForChangeType, seedFromCategory,
  type ChangeRoute,
} from "../payrollChangeTypes.js";
import { isValidPayDate, payDateFor, periodDatesFor } from "../payrollPeriod.js";

/**
 * Turn the model's judgment into rows the ledger can accept.
 *
 * This is the server port of the hand-run `build-payload.ts` that produced the
 * 76 rows on 2026-09-16, and it keeps that script's central discipline: the
 * MODEL SUPPLIES JUDGMENT ONLY. Across all 76 real rows the model never once
 * supplied a Graph id, a conversation id or an Outlook category — those come
 * from the message record, here. Asking a model for an identifier is asking it
 * to invent one, and the Create-PDF flow files a document against that id.
 *
 * ⚠️ One deliberate difference from the script. It called `process.exit(1)` on
 * any problem, which is right for a human at a terminal and wrong for a 5am
 * job: one malformed row would mean Tiana opens an empty board. So a row with
 * a structural problem is REJECTED INDIVIDUALLY and handed to the review
 * queue with the reason. Nothing is coerced, and nothing is silently dropped.
 */

/** What the classifier is allowed to emit. Judgment, no identifiers. */
export type ClassifiedAction = {
  /** Stable within one message, so pairs can reference each other. */
  ref: string;
  payDate: string;
  customer?: string | null;
  employee?: string | null;
  peopleCount?: number;
  changeType: string;
  /** Only when the taxonomy's default is wrong (in practice: terminations). */
  route?: string | null;
  amount?: number | null;
  hours?: number | null;
  weekEnding?: string | null;
  effectiveDate?: string | null;
  isRetro?: boolean;
  action: string;
  supersedes?: string | null;
  /** Another row's `ref` in the same message. */
  pairedWith?: string | null;
  requestedBy?: string | null;
  approvedBy?: string | null;
  needsDecision?: boolean;
  decisionQuestion?: string | null;
  decisionOwner?: string | null;
  /** Distinguishes two same-type actions for one person in one week. */
  keySuffix?: string | null;
};

/** Provenance, taken from the message — never from the model. */
export type SourceFacts = {
  conversationId: string | null;
  sourceMessageId: string;
  sourceRef: string;
  sourceReceivedAt: Date | null;
  category: string | null;
};

export type BuiltRow = {
  ref: string;
  payDate: string;
  row: SweptRow;
};

export type RejectedRow = {
  ref: string;
  payDate: string;
  /** Partial row, kept whole so a reviewer can see what was proposed. */
  row: Record<string, unknown>;
  reason: "no_route" | "unknown_type" | "invalid";
  detail: string;
};

export type BuildResult = {
  built: BuiltRow[];
  rejected: RejectedRow[];
};

/**
 * Which period a row belongs to, honouring Brad's standing rule that a CLOSED
 * period is never repopulated.
 *
 * A change whose effect lands in a period that has already paid does not
 * vanish — it becomes a retro row on the period that is still open, prefixed
 * so the processor can see at a glance that it is catching up. That is exactly
 * what the 09.16 run did with the seven PD 09.11 misses.
 */
export function placePeriod(
  requestedPayDate: string,
  todayIso: string,
  closedPayDates: ReadonlySet<string>,
): { payDate: string; retargeted: boolean } {
  // ⚠️ `payDateFor` is inclusive of today on purpose: Friday is a working day
  // of the period that pays that same Friday, and a sweep running on Friday
  // morning must not jump a week ahead.
  const open = payDateFor(todayIso);
  const isClosed = closedPayDates.has(requestedPayDate) || requestedPayDate < open;
  if (!isClosed) return { payDate: requestedPayDate, retargeted: false };
  return { payDate: open, retargeted: true };
}

const RETRO_PREFIX = "RETRO — ";

export function buildRows(
  actions: ClassifiedAction[],
  source: SourceFacts,
  opts: { todayIso: string; closedPayDates: ReadonlySet<string> },
): BuildResult {
  const built: BuiltRow[] = [];
  const rejected: RejectedRow[] = [];

  // Pass 1 — canonicalise, validate, key. Keys must exist before pairing.
  type Staged = {
    a: ClassifiedAction;
    payDate: string;
    changeType: string;
    route: ChangeRoute | null;
    isRetro: boolean;
    action: string;
    rowKey: string;
  };
  const staged: Staged[] = [];

  for (const a of actions) {
    const problems: string[] = [];
    const changeType = normalizeChangeType(a.changeType);

    // "Other" means the taxonomy did not recognise it. Surface that rather
    // than filing it under whatever was closest.
    if (changeType === "Other") {
      rejected.push({
        ref: a.ref, payDate: a.payDate, row: { ...a },
        reason: "unknown_type",
        detail: `change type "${a.changeType}" did not match the taxonomy`,
      });
      continue;
    }

    const explicitRoute = a.route && (CHANGE_ROUTES as readonly string[]).includes(a.route)
      ? (a.route as ChangeRoute)
      : null;
    const route = explicitRoute
      ?? routeForChangeType(changeType)
      ?? seedFromCategory(source.category)?.route
      ?? null;
    if (!route) {
      rejected.push({
        ref: a.ref, payDate: a.payDate, row: { ...a },
        reason: "no_route",
        detail: `no route for ${changeType} — it would land in "Needs a route"`,
      });
      continue;
    }

    if (!a.action?.trim()) problems.push("empty action");
    if (!isValidPayDate(a.payDate)) problems.push(`invalid payDate ${a.payDate}`);
    if (a.amount != null && !Number.isFinite(a.amount)) problems.push("amount not numeric");
    if (a.hours != null && !Number.isFinite(a.hours)) problems.push("hours not numeric");
    if (a.weekEnding && !/^\d{4}-\d{2}-\d{2}$/.test(a.weekEnding)) {
      problems.push(`weekEnding "${a.weekEnding}" is not YYYY-MM-DD`);
    }
    if (a.effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(a.effectiveDate)) {
      problems.push(`effectiveDate "${a.effectiveDate}" is not YYYY-MM-DD`);
    }
    // ⚠️ Rates are not amounts. Amount is real dollars — advances, gross-ups,
    // weekly deduction amounts; a pay rate belongs in the instruction text. A
    // small positive number on a rate change is a rate that has wandered into
    // the money column, and it would be read as a dollar figure downstream.
    if (a.amount != null && a.amount > 0 && a.amount < 40 && /rate/i.test(changeType)) {
      problems.push(`amount ${a.amount} looks like a RATE on a rate change`);
    }
    if (a.needsDecision && !a.decisionQuestion?.trim()) {
      problems.push("needsDecision without a decisionQuestion");
    }
    if (problems.length) {
      rejected.push({
        ref: a.ref, payDate: a.payDate, row: { ...a },
        reason: "invalid", detail: problems.join("; "),
      });
      continue;
    }

    const placed = placePeriod(a.payDate, opts.todayIso, opts.closedPayDates);
    const ppe = periodDatesFor(placed.payDate).ppeDate;
    // Retro is COMPUTED unless the classifier insisted: a row belongs to a
    // prior week whenever its week ending precedes this period's PPE. A
    // retargeted row is retro by construction.
    const isRetro = placed.retargeted
      || a.isRetro
      || (a.weekEnding ? a.weekEnding < ppe : false);

    let action = a.action.trim();
    if (isRetro && !action.startsWith(RETRO_PREFIX)) action = RETRO_PREFIX + action;

    // keySuffix widens the key so two same-type actions for one person in one
    // week (a second bus ticket at a different price) stay two rows instead of
    // collapsing into one on the unique (periodId, rowKey).
    const weekForKey = a.keySuffix
      ? `${a.weekEnding ?? ""}#${a.keySuffix}`
      : (a.weekEnding ?? null);

    staged.push({
      a, payDate: placed.payDate, changeType, route, isRetro, action,
      rowKey: rowKeyFor({
        conversationId: source.conversationId,
        employee: a.employee ?? null,
        changeType,
        weekEnding: weekForKey,
      }),
    });
  }

  // Pass 2 — collisions. Two rows sharing a key inside one period would
  // silently collapse on the upsert, so the second one is refused rather than
  // quietly swallowing the first.
  const seen = new Map<string, string>();
  const keyByRef = new Map<string, string>();
  const survivors: Staged[] = [];
  for (const s of staged) {
    const k = `${s.payDate}|${s.rowKey}`;
    const prior = seen.get(k);
    if (prior) {
      rejected.push({
        ref: s.a.ref, payDate: s.payDate, row: { ...s.a },
        reason: "invalid",
        detail: `row key collides with ${prior} in ${s.payDate} — needs a keySuffix`,
      });
      continue;
    }
    seen.set(k, s.a.ref);
    keyByRef.set(s.a.ref, s.rowKey);
    survivors.push(s);
  }

  // Pass 3 — emit. Pairing resolves by ref within this message.
  for (const s of survivors) {
    const paired = s.a.pairedWith ? keyByRef.get(s.a.pairedWith) ?? null : null;
    const row: SweptRow = {
      rowKey: s.rowKey,
      customer: s.a.customer ?? null,
      employee: s.a.employee ?? null,
      peopleCount: s.a.peopleCount ?? 1,
      route: s.route,
      changeType: s.changeType as SweptRow["changeType"],
      changeTypeRaw: s.a.changeType,
      amount: s.a.amount ?? null,
      hours: s.a.hours ?? null,
      weekEnding: s.a.weekEnding ?? null,
      effectiveDate: s.a.effectiveDate ?? null,
      isRetro: s.isRetro,
      action: s.action,
      supersedes: s.a.supersedes ?? null,
      pairedWithRowKey: paired,
      requestedBy: s.a.requestedBy ?? null,
      approvedBy: s.a.approvedBy ?? null,
      category: source.category,
      conversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceRef: source.sourceRef,
      sourceReceivedAt: source.sourceReceivedAt,
    };
    // ⚠️ `needsDecision` is set only when we mean it. The ingest treats an
    // absent key as "not supplied" and carries the stored value; sending
    // `false` every time would re-open decisions a human had closed.
    if (s.a.needsDecision) {
      row.needsDecision = true;
      row.decisionQuestion = s.a.decisionQuestion ?? null;
      row.decisionOwner = s.a.decisionOwner ?? null;
    }
    built.push({ ref: s.a.ref, payDate: s.payDate, row });
  }

  return { built, rejected };
}
