import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChangeType, parseVerification, isVerified, CHANGE_TYPES,
  ROUTE_FOR, ROUTE_ORDER, routeForChangeType, seedFromCategory,
} from "../payrollChangeTypes";

describe("normalizeChangeType — real drift from the ledger", () => {
  it("collapses the eight spellings of Housing Deductions Pro Rate", () => {
    const spellings = [
      "Housing Deductions Pro rate", "Housing Deductions Pro Rate",
      "Housing deductions pro rate", "Housing Deducations pro rate",
      "Housing deduction pro rate", "Housing Deductions pro rate",
      "Housing deductions Pro Rate", "Housing Deductions double- pro rate",
    ];
    for (const s of spellings) {
      assert.equal(normalizeChangeType(s), "Housing Deductions Pro Rate", s);
    }
  });

  it("treats & and 'and' as the same word", () => {
    assert.equal(
      normalizeChangeType("Housing & Transportation Deductions Stop"),
      normalizeChangeType("Housing and Transportation Deductions Stop"),
    );
  });

  it("repairs the Deducations / Transportations / udpate typos", () => {
    assert.equal(normalizeChangeType("Transportation Deducations Stop"), "Transportation Deductions Stop");
    assert.equal(normalizeChangeType("Transportations Deduction Start and Pro Rate"), "Transportation Deductions Start and Pro Rate");
    assert.equal(normalizeChangeType("Housing Deductions udpate"), "Housing Deductions Update");
  });

  it("classifies 'update AND pro rate' as the pro rate", () => {
    // Genuinely both. Pro Rate wins because that is the half with a
    // calculation and a tie-out, so it files with the other pro-rate rows —
    // which is where the person doing the work will look for it.
    assert.equal(
      normalizeChangeType("Housing deductions udpate and pro rate"),
      "Housing Deductions Pro Rate",
    );
  });

  it("prefers the MORE SPECIFIC rule — combined beats single", () => {
    // "Housing and Transportation ... Stop" must not fall to "Housing ... Stop".
    assert.equal(
      normalizeChangeType("Housing and Transportation Deductions Stop"),
      "Housing and Transportation Deductions Stop",
    );
    assert.equal(normalizeChangeType("Housing Deductions Stop"), "Housing Deductions Stop");
  });

  it("prefers 'Start and Pro Rate' over either half", () => {
    assert.equal(
      normalizeChangeType("Housing Deductions Start and Pro rate"),
      "Housing Deductions Start and Pro Rate",
    );
    assert.equal(normalizeChangeType("Housing Deductions Start"), "Housing Deductions Start");
    assert.equal(normalizeChangeType("Housing Deductions Pro rate"), "Housing Deductions Pro Rate");
  });

  it("keeps retro, refund and plain apart", () => {
    assert.equal(normalizeChangeType("Retro Housing Deductions"), "Retro Housing Deductions");
    assert.equal(normalizeChangeType("Refund Housing deductions"), "Refund Housing Deductions");
    assert.equal(normalizeChangeType("Retro Housing Fringe"), "Retro Housing Fringe");
    assert.equal(normalizeChangeType("Housing Fringe"), "Housing Fringe");
  });

  it("separates the three bonus flavours", () => {
    assert.equal(normalizeChangeType("Bonus Referral"), "Bonus Referral");
    assert.equal(normalizeChangeType("Bonus Incentive"), "Bonus Incentive");
    assert.equal(normalizeChangeType("Bonus March Madness"), "Bonus");
  });

  it("returns Other for something genuinely unrecognised, rather than guessing", () => {
    assert.equal(normalizeChangeType("Reimburse the moon"), "Other");
    assert.equal(normalizeChangeType(""), "Other");
  });

  it("every rule target is a declared change type", () => {
    const declared = new Set<string>(CHANGE_TYPES);
    const samples = [
      "Housing Fringe", "MN ESST", "Special pay rate", "Pay rate increase",
      "Bill Rate Reduction", "Retro pay OT", "Direct deposit update",
      "Advance payback", "Tax corrections for PA eli", "Pay no bill",
      "Driver hours adjustment", "Vacation Pay", "Holiday Pay",
    ];
    for (const s of samples) assert.ok(declared.has(normalizeChangeType(s)), s);
  });
});

describe("parseVerification — an x per person, not a boolean", () => {
  it("reads n/a as not applicable", () => {
    assert.deepEqual(parseVerification("n/a"), { kind: "not_applicable" });
  });

  it("counts the x's, because a multi-person row gets one each", () => {
    assert.deepEqual(parseVerification("x"), { kind: "count", done: 1 });
    assert.deepEqual(parseVerification("xxx"), { kind: "count", done: 3 });
    assert.deepEqual(parseVerification("xxxxx"), { kind: "count", done: 5 });
  });

  it("treats blank as nothing done", () => {
    assert.deepEqual(parseVerification(""), { kind: "count", done: 0 });
    assert.deepEqual(parseVerification(null), { kind: "count", done: 0 });
  });

  it("does NOT call a five-person row done when one person is entered", () => {
    // Modelling this as a boolean is the bug: 'x' on a row naming five people
    // would read as complete and four people would never be entered.
    assert.equal(isVerified(parseVerification("x"), 5), false);
    assert.equal(isVerified(parseVerification("xxxxx"), 5), true);
  });

  it("not-applicable counts as verified regardless of headcount", () => {
    assert.equal(isVerified(parseVerification("n/a"), 5), true);
  });

  it("tolerates a capital X", () => {
    assert.equal(isVerified(parseVerification("X"), 1), true);
  });
});

describe("routeForChangeType — where in Zenople, when in the week", () => {
  it("covers every declared change type", () => {
    for (const t of CHANGE_TYPES) {
      assert.ok(t in ROUTE_FOR, `no route decision for ${t}`);
    }
  });

  it("routes earnings-and-billing work to TMS, before the batch close", () => {
    assert.equal(routeForChangeType("Pay Rate Increase"), "TMS");
    assert.equal(routeForChangeType("Retro Pay"), "TMS");
    assert.equal(routeForChangeType("Driver Adjustment"), "TMS");
    assert.equal(routeForChangeType("Bill Rate Change"), "TMS");
  });

  it("routes deduction starts/stops/pro-rates to PAS, after invoicing", () => {
    assert.equal(routeForChangeType("Housing Deductions Start"), "PAS");
    assert.equal(routeForChangeType("Transportation Deductions Pro Rate"), "PAS");
    assert.equal(routeForChangeType("Advance Pay Back"), "PAS");
    assert.equal(routeForChangeType("Tax Update"), "PAS");
  });

  it("THE REFUND RULE: a refund is 2TMS even though the deduction it undoes is PAS", () => {
    // Tiana files Acevedo/Cruz refunds as 2TMS in the same week she files
    // Russell/Cortez pro-rates as PAS. Money back to the employee = earnings side.
    assert.equal(routeForChangeType("Refund Transportation Deductions"), "2TMS");
    assert.equal(routeForChangeType("Refund Housing Deductions"), "2TMS");
    assert.equal(routeForChangeType("Transportation Deductions Stop"), "PAS");
  });

  it("MN ESST rides the round-2 import (Brad, 2026-09-01)", () => {
    assert.equal(routeForChangeType("MN ESST"), "2TMS");
  });

  it("terminations are Ops — Zenople housekeeping before the Master export", () => {
    assert.equal(normalizeChangeType("Termination"), "Termination");
    assert.equal(normalizeChangeType("Term and work state fix"), "Termination");
    assert.equal(routeForChangeType("Termination"), "Ops");
  });

  it("refuses to guess a route for Other", () => {
    assert.equal(routeForChangeType("Other"), null);
  });

  it("orders the board the way the week runs", () => {
    assert.deepEqual([...ROUTE_ORDER], ["Ops", "TMS", "2TMS", "PAS"]);
  });
});

describe("seedFromCategory — Tiana's Outlook tag as a prior", () => {
  it("seeds the route from her named tags", () => {
    assert.deepEqual(seedFromCategory("Pay Rate Change"), { route: "TMS" });
    assert.deepEqual(seedFromCategory("Sick Time"),
      { changeType: "MN ESST", route: "2TMS" });
    assert.equal(seedFromCategory("Transportation")?.route, "PAS");
    assert.equal(seedFromCategory("Housing Change")?.route, "PAS");
  });

  it("an unnamed colour category means nothing", () => {
    // The name IS the colour — it carries no classification.
    assert.equal(seedFromCategory("Green Category"), null);
  });

  it("no tag, no seed — the body decides alone", () => {
    assert.equal(seedFromCategory(null), null);
    assert.equal(seedFromCategory(""), null);
    assert.equal(seedFromCategory("Some Unknown Tag"), null);
  });
});
