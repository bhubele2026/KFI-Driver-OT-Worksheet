import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { humanHasTouched, rowIsFaithful, wouldDisturbVerified } from "../verify";

const body = `Hi Tiana,
Please deduct an additional $85.99 — the travel date moved and the updated bus
ticket cost more. Second deduction alongside the $160.24; both on his first
check. Effective 9/15/2026. He worked 10.00 hrs that week.
Thanks, Dawn`;

describe("rowIsFaithful", () => {
  it("passes a row whose figures are all in the email", () => {
    assert.equal(rowIsFaithful({
      action: "Deduct an additional $85.99 alongside the $160.24",
      amount: 85.99, hours: null,
      weekEnding: null, effectiveDate: "2026-09-15",
    }, body).ok, true);
  });

  it("catches an amount the email never states", () => {
    // The corruption this exists to stop: 185.99 for an email's 85.99.
    const r = rowIsFaithful({ action: "Deduct $185.99", amount: 185.99 }, body);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.detail.includes("185.99"));
  });

  it("accepts $100 written as 100.00", () => {
    // The model reformats money constantly. Rejecting that would queue nearly
    // every row and make the feature useless.
    assert.equal(rowIsFaithful(
      { action: "Record a $100.00 advance", amount: 100 },
      "approved a $100 advance for him",
    ).ok, true);
  });

  it("matches an ISO date against the way a human wrote it", () => {
    // "2026-09-15" appears in no email ever written; "9/15/2026" does.
    assert.equal(rowIsFaithful({ action: "Stop it", effectiveDate: "2026-09-15" }, body).ok, true);
    assert.equal(rowIsFaithful({ action: "Stop it", effectiveDate: "2026-11-03" }, body).ok, false);
  });

  it("does not trip over years or small counts in the instruction", () => {
    assert.equal(rowIsFaithful(
      { action: "Enter 10.00 hrs for 3 people in 2026" },
      "please enter 10.00 hrs for the three of them",
    ).ok, true);
  });
});

describe("wouldDisturbVerified", () => {
  const stored = {
    amount: 100, action: "Record a $100 advance", route: "PAS",
    changeType: "Advance", hours: null, effectiveDate: null,
    weekEnding: "2026-09-12", peopleCount: 1,
    enteredZenople: 1, verifiedTs: 1, verifiedPas: 0, documentationSaved: 0,
  };

  it("blocks a sweep that would move money under an already-ticked row", () => {
    // The merge protects her CHECK-OFFS. It does not protect her CONFIDENCE in
    // the number she checked — this does.
    const r = wouldDisturbVerified({ ...stored, amount: 250 }, stored);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "would_change_verified");
      assert.ok(r.detail.includes("amount"));
    }
  });

  it("allows an identical re-sweep of a ticked row", () => {
    assert.equal(wouldDisturbVerified({ ...stored }, stored).ok, true);
  });

  it("allows any change to a row nobody has touched", () => {
    const untouched = { ...stored, enteredZenople: 0, verifiedTs: 0 };
    assert.equal(wouldDisturbVerified({ ...untouched, amount: 999 }, untouched).ok, true);
  });

  it("treats n/a as a human decision, not an empty cell", () => {
    assert.equal(humanHasTouched({
      enteredZenople: -1, verifiedTs: 0, verifiedPas: 0, documentationSaved: 0,
    }), true);
  });
});
