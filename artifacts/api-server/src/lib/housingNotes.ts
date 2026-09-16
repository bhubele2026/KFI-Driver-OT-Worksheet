/**
 * Housing's hand-filed payroll notes: the vocabulary, the routing, and the one
 * date conversion.
 *
 * Brad, 2026-09-16: a coordinator in the Housing app picks a person, says what
 * payroll must do, and types what happened. This module is everything about
 * that record that is a RULE rather than a row, so it can be unit-tested with
 * no database and no HTTP.
 */
import { addDays } from "./time.js";
import { isValidPayDate, payDateForWeekOf } from "./payrollPeriod.js";
import { ROUTE_FOR, type ChangeRoute, type ChangeType } from "./payrollChangeTypes.js";

/**
 * What the Housing coordinator can ask for, in HER words on that screen.
 *
 * ⚠️ DELIBERATELY SHORT. The canonical taxonomy has 47 types; asking someone
 * outside payroll to pick from 47 is how you get "Other" 47 times. These five
 * are the ones a housing or transportation coordinator actually originates —
 * everything else reaches payroll through the mail sweep, which keeps its own
 * full vocabulary.
 */
export const ASKS = [
  "stop_housing",
  "stop_transportation",
  "terminated",
  "rate_change",
  "other",
] as const;
export type Ask = (typeof ASKS)[number];

export const isAsk = (v: unknown): v is Ask =>
  typeof v === "string" && (ASKS as readonly string[]).includes(v);

/** How the ask reads on a payroll screen. Housing words it for Lino separately. */
export const ASK_LABEL: Record<Ask, string> = {
  stop_housing: "Stop the housing deduction",
  stop_transportation: "Stop the transportation deduction",
  terminated: "Terminated",
  rate_change: "Rate changed",
  other: "Something else",
};

/**
 * The canonical type each ask maps onto.
 *
 * ⚠️ `rate_change` IS NULL ON PURPOSE. The taxonomy has Pay Rate Increase,
 * Decrease and Correction and they are three different entries; a note that
 * says only "his rate changed" does not say which, and guessing one would put
 * a wrong type on a row that affects billing. It still ROUTES (see below) —
 * it lands in TMS where it belongs — but it shows as needing to be said.
 */
export const ASK_TYPE: Record<Ask, ChangeType | null> = {
  stop_housing: "Housing Deductions Stop",
  stop_transportation: "Transportation Deductions Stop",
  terminated: "Termination",
  rate_change: null,
  other: "Other",
};

/**
 * Which day of the week's work this lands on.
 *
 * Derived from `ROUTE_FOR` wherever a type exists, so the note sorts exactly
 * like the equivalent row on the Changes board and the two boards can never
 * drift. Only `rate_change` needs its own answer, and TMS is where every one
 * of the three rate types routes.
 */
export function askToRoute(ask: Ask): ChangeRoute | null {
  if (ask === "rate_change") return "TMS";
  const t = ASK_TYPE[ask];
  return t === null ? null : ROUTE_FOR[t];
}

/**
 * ⭐ THE ONE DATE CONVERSION, AND IT LIVES ON THIS SIDE ON PURPOSE.
 *
 * Housing keys pay weeks on the SATURDAY they end (`deduction_weeks.pay_week_end`,
 * and its standing rule that a pay week is a Saturday string). This app keys a
 * period on the FRIDAY it pays. The two are six days apart — usually.
 *
 * ⚠️ WHY HOUSING MUST NOT DO THIS ARITHMETIC ITSELF. When that Friday is a bank
 * holiday the period pays the THURSDAY before, so the gap is five days, not six.
 * `BANK_HOLIDAYS` is a maintained 2025–28 table in payrollPeriod.ts and it must
 * live in exactly one place; a naive +6 in Housing would send a Friday this app
 * rejects, on eight dates between now and 2028 (2026-12-25 and 2027-01-01 among
 * them). Housing sends its Saturday, this function answers, and the answer is
 * echoed back so Housing displays our period rather than its own guess.
 *
 * The Saturday it takes is the period's PPE date: `periodDatesFor` derives
 * `ppeDate = nominalFriday - 6`, so the inverse is `nominalFriday = ppe + 6`.
 */
export function payDateFromPayWeekEnd(payWeekEnd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payWeekEnd)) return null;
  // Saturday = 6. A week that does not end on a Saturday is not a pay week here.
  if (new Date(`${payWeekEnd}T00:00:00Z`).getUTCDay() !== 6) return null;
  const payDate = payDateForWeekOf(addDays(payWeekEnd, 6));
  return isValidPayDate(payDate) ? payDate : null;
}

/**
 * The Zenople PersonId, or a refusal.
 *
 * ⚠️ NEVER COERCE A BAD ONE TO NULL. PersonId is the only key anything here is
 * allowed to join on, so a note whose person cannot be resolved has to come
 * back to Housing with a reason and be shown there as undeliverable. Stored
 * with a null key it would render as a task nobody could action and nobody
 * could trace — which is the exact silent failure this feature exists to stop.
 */
export function parsePersonId(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** One note as Housing sends it. Everything optional is a fact Housing may not hold. */
export interface IncomingNote {
  noteKey?: unknown;
  personId?: unknown;
  personName?: unknown;
  ask?: unknown;
  note?: unknown;
  customer?: unknown;
  shift?: unknown;
  propertyName?: unknown;
  roomLabel?: unknown;
  bedLabel?: unknown;
  vanLabel?: unknown;
  vanRole?: unknown;
  weeklyRent?: unknown;
  deducted?: unknown;
  deductedWeek?: unknown;
  byEmail?: unknown;
  notedAt?: unknown;
  voidedAt?: unknown;
}

export type NoteRejection = { noteKey: string; reason: string };

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};
const money = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
};
const when = (v: unknown): Date | null => {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** A note validated into exactly what the table stores, or a named refusal. */
export type ValidatedNote = {
  noteKey: string;
  personId: number;
  personName: string;
  ask: Ask;
  changeType: string | null;
  route: string | null;
  note: string;
  customer: string | null;
  shift: string | null;
  propertyName: string | null;
  roomLabel: string | null;
  bedLabel: string | null;
  vanLabel: string | null;
  vanRole: string | null;
  weeklyRent: string | null;
  deducted: string | null;
  deductedWeek: string | null;
  byEmail: string | null;
  notedAt: Date | null;
  voidedAt: Date | null;
};

export function validateNote(
  raw: IncomingNote,
): { ok: true; note: ValidatedNote } | { ok: false; rejection: NoteRejection } {
  const noteKey = str(raw.noteKey);
  // With no key there is nothing to report a refusal against, and nothing that
  // could ever be updated or retracted. It is the one unrecoverable case.
  if (noteKey === null) {
    return { ok: false, rejection: { noteKey: "", reason: "noteKey is required" } };
  }
  const bad = (reason: string) => ({ ok: false as const, rejection: { noteKey, reason } });

  const personId = parsePersonId(raw.personId);
  if (personId === null) {
    return bad("personId is not a Zenople PersonId — the note cannot be matched to anyone here");
  }
  const personName = str(raw.personName);
  if (personName === null) return bad("personName is required");
  if (!isAsk(raw.ask)) return bad(`ask must be one of: ${ASKS.join(", ")}`);
  const note = str(raw.note);
  if (note === null) return bad("note is required — the words are the whole point of the record");

  const ask = raw.ask;
  return {
    ok: true,
    note: {
      noteKey,
      personId,
      personName,
      ask,
      changeType: ASK_TYPE[ask],
      route: askToRoute(ask),
      note,
      customer: str(raw.customer),
      shift: str(raw.shift),
      propertyName: str(raw.propertyName),
      roomLabel: str(raw.roomLabel),
      bedLabel: str(raw.bedLabel),
      vanLabel: str(raw.vanLabel),
      vanRole: str(raw.vanRole),
      weeklyRent: money(raw.weeklyRent),
      deducted: money(raw.deducted),
      deductedWeek: str(raw.deductedWeek),
      byEmail: str(raw.byEmail),
      notedAt: when(raw.notedAt),
      voidedAt: when(raw.voidedAt),
    },
  };
}
