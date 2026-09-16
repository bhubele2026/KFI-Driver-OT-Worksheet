import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ASKS, ASK_LABEL, ASK_TYPE, askToRoute, isAsk,
  parsePersonId, payDateFromPayWeekEnd, validateNote,
} from "../housingNotes.js";
import { payDates, periodDatesFor } from "../payrollPeriod.js";
import { ROUTE_ORDER as ROUTES } from "../payrollChangeTypes.js";

/**
 * The rules behind the notes the Housing app files here. All pure — no
 * database, no HTTP — so the things that would silently lose somebody's work
 * are checked on every run.
 */

// ── the vocabulary ──────────────────────────────────────────────────────────

test("every ask has words, and routes somewhere real or nowhere at all", () => {
  for (const ask of ASKS) {
    assert.ok(ASK_LABEL[ask], `${ask} needs words a person would say`);
    const route = askToRoute(ask);
    if (route !== null) {
      assert.ok(ROUTES.includes(route), `${ask} routed to ${route}, which is not a real route`);
    }
  }
});

test("the deduction stops land in PAS and a termination lands in Ops", () => {
  // These two carry Brad's whole point: the note has to arrive on the right
  // day of the week's work, not in an undifferentiated pile.
  assert.equal(ASK_TYPE.stop_housing, "Housing Deductions Stop");
  assert.equal(askToRoute("stop_housing"), "PAS");
  assert.equal(ASK_TYPE.stop_transportation, "Transportation Deductions Stop");
  assert.equal(askToRoute("stop_transportation"), "PAS");
  assert.equal(ASK_TYPE.terminated, "Termination");
  assert.equal(askToRoute("terminated"), "Ops");
});

test("a rate change routes to TMS but refuses to guess WHICH rate change", () => {
  // Increase, Decrease and Correction are three different entries and the note
  // says none of them. Guessing one puts a wrong type on a row that moves
  // billing, so it routes (TMS is where all three live) and stays untyped.
  assert.equal(askToRoute("rate_change"), "TMS");
  assert.equal(ASK_TYPE.rate_change, null);
});

test("`other` is unrouted, loudly — never quietly guessed into a stage", () => {
  assert.equal(askToRoute("other"), null);
});

test("isAsk refuses anything not on the list", () => {
  assert.ok(isAsk("terminated"));
  assert.ok(!isAsk("Terminated"));
  assert.ok(!isAsk("stop_housing "));
  assert.ok(!isAsk(""));
  assert.ok(!isAsk(undefined));
});

// ── the week key ────────────────────────────────────────────────────────────

test("Housing's Saturday round-trips to our pay date, for every real period", () => {
  // The property that matters: for any pay date this app will offer in its
  // picker, the Saturday Housing would file against converts back to exactly
  // that pay date. Written as a round trip rather than hand-computed weekdays
  // so it cannot drift with the calendar.
  for (const { payDate } of payDates("2026-09-16", 60, 60)) {
    const saturday = periodDatesFor(payDate).ppeDate;
    assert.equal(
      payDateFromPayWeekEnd(saturday), payDate,
      `pay week ending ${saturday} should pay on ${payDate}`,
    );
  }
});

test("⚠️ a Friday bank holiday pays the Thursday — the reason Housing must not do this sum", () => {
  // Christmas 2026 falls on the Friday. Saturday + 6 would send 2026-12-25,
  // which this app rejects as not a pay date; the real answer is the 24th.
  // A naive +6 in the Housing app would strand the note.
  assert.equal(payDateFromPayWeekEnd("2026-12-19"), "2026-12-24");
});

test("a week that does not end on a Saturday is refused, not rounded", () => {
  assert.equal(payDateFromPayWeekEnd("2026-09-18"), null); // a Friday
  assert.equal(payDateFromPayWeekEnd("2026-09-13"), null); // a Sunday
  assert.equal(payDateFromPayWeekEnd("not-a-date"), null);
  assert.equal(payDateFromPayWeekEnd(""), null);
});

// ── identity ────────────────────────────────────────────────────────────────

test("PersonId parses or refuses — it is never coerced to null", () => {
  assert.equal(parsePersonId("2004863"), 2004863);
  assert.equal(parsePersonId(2004863), 2004863);
  assert.equal(parsePersonId(" 2004863 "), 2004863);
  // Each of these used to be a candidate for "store it as null and move on",
  // which produces a task nobody can action and nobody can trace.
  assert.equal(parsePersonId(""), null);
  assert.equal(parsePersonId("abc"), null);
  assert.equal(parsePersonId("0"), null);
  assert.equal(parsePersonId("-1"), null);
  assert.equal(parsePersonId("12.5"), null);
  assert.equal(parsePersonId(null), null);
  assert.equal(parsePersonId(undefined), null);
});

// ── validation ──────────────────────────────────────────────────────────────

const good = {
  noteKey: "b6d0f2e0-0000-4000-8000-000000000001",
  personId: "2004863",
  personName: "Jose Angulo Alfaro",
  ask: "stop_housing",
  note: "He abandoned the job on Monday.",
  propertyName: "Prairie Hill Village",
  roomLabel: "rm2",
  bedLabel: "1",
  weeklyRent: 125,
  deducted: "125.00",
};

test("a complete note validates and derives its own type and route", () => {
  const v = validateNote(good);
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.note.personId, 2004863);
  assert.equal(v.note.changeType, "Housing Deductions Stop");
  assert.equal(v.note.route, "PAS");
  // Money is stored to the cent as text, the way every other money column here is.
  assert.equal(v.note.weeklyRent, "125.00");
  assert.equal(v.note.deducted, "125.00");
});

test("every refusal names the note it refused, so Housing can show it", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...good, personId: "" }, /PersonId/],
    [{ ...good, personId: "abc" }, /PersonId/],
    [{ ...good, personName: "" }, /personName/],
    [{ ...good, ask: "stop_everything" }, /ask must be one of/],
    [{ ...good, note: "   " }, /note is required/],
  ];
  for (const [body, reason] of cases) {
    const v = validateNote(body);
    assert.ok(!v.ok, `${JSON.stringify(body.ask ?? body.personId)} should have been refused`);
    if (v.ok) continue;
    assert.equal(v.rejection.noteKey, good.noteKey, "the refusal must name the note");
    assert.match(v.rejection.reason, reason);
  }
});

test("a note with no key is the one unrecoverable case", () => {
  // Nothing to report a refusal against, and nothing that could ever be
  // updated or retracted later.
  const v = validateNote({ ...good, noteKey: "" });
  assert.ok(!v.ok);
  if (v.ok) return;
  assert.equal(v.rejection.noteKey, "");
  assert.match(v.rejection.reason, /noteKey is required/);
});

test("blank optional facts become null, never empty strings", () => {
  const v = validateNote({ ...good, customer: "  ", vanLabel: "", deductedWeek: null });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.note.customer, null);
  assert.equal(v.note.vanLabel, null);
  assert.equal(v.note.deductedWeek, null);
});

// ── the property the closed loop rests on ───────────────────────────────────

test("⚠️⚠️ a re-push can never un-tick the processor's work", () => {
  /**
   * Housing re-sends every note for the period each time its board is opened.
   * If the receiving upsert listed the handled columns in its `set` block, that
   * reconcile would silently clear Tiana's ticks — the same clobber the change
   * sweep's set block was written to avoid. This is a source read because the
   * property lives in the shape of one statement, and a unit test with a fake
   * database would pass whatever that statement said.
   */
  const src = readFileSync(
    fileURLToPath(new URL("../../routes/machinePayroll.ts", import.meta.url)),
    "utf8",
  );
  const start = src.indexOf('body.kind === "housing-notes"');
  assert.ok(start > 0, "the housing-notes branch should exist");
  const branch = src.slice(start, src.indexOf("const payDate = body.payDate", start));
  assert.ok(branch.includes("onConflictDoUpdate"), "notes should upsert, not duplicate");

  // Only the WRITE matters. The branch mentions the handled columns twice for
  // legitimate reasons — it selects them to send the state back to Housing —
  // so scanning the whole branch would fail on the very feature it protects.
  const factsStart = branch.indexOf("const facts = {");
  assert.ok(factsStart > 0, "the pushed facts should be one named object");
  const facts = branch.slice(factsStart, branch.indexOf("};", factsStart));
  for (const owned of ["handledAt", "handledBy", "handledNote"]) {
    assert.ok(
      !facts.includes(owned),
      `${owned} must not be a pushed fact — it is this app's own column`,
    );
  }
  // …and the set block writes those facts and nothing else.
  assert.match(
    branch, /set:\s*\{\s*\.\.\.facts,\s*updatedAt:\s*now\s*\}/,
    "the upsert must write exactly the pushed facts, so a re-push cannot clear a tick",
  );
});
