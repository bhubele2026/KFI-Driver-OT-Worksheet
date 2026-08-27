import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proRate, proRatePerson, fringeAndRentAgree } from "../payrollProRate";

describe("proRate — against the real Pro Rate Calculations tab", () => {
  it("reproduces the workbook's own numbers", () => {
    // Every one of these is a row from PD 08.28.2026.
    assert.equal(proRate({ weeklyAmount: 69.23, days: 1 }).amount, 9.89);
    assert.equal(proRate({ weeklyAmount: 69.23, days: 3 }).amount, 29.67);
    assert.equal(proRate({ weeklyAmount: 69.23, days: 5 }).amount, 49.45);
    assert.equal(proRate({ weeklyAmount: 40, days: 3 }).amount, 17.14);
    assert.equal(proRate({ weeklyAmount: 40, days: 2 }).amount, 11.43);
  });

  it("rounds to cents but keeps the exact value visible", () => {
    // The tab stores 17.142857142857142. A deduction cannot be that.
    const r = proRate({ weeklyAmount: 40, days: 3 });
    assert.equal(r.amount, 17.14);
    assert.ok(Math.abs(r.exact - 17.142857142857142) < 1e-12);
  });

  it("handles the full week and the empty week", () => {
    assert.equal(proRate({ weeklyAmount: 175, days: 7 }).amount, 175);
    assert.equal(proRate({ weeklyAmount: 175, days: 0 }).amount, 0);
  });

  it("rejects a day count that cannot be a week", () => {
    assert.throws(() => proRate({ weeklyAmount: 40, days: 8 }), /days must be 0-7/);
    assert.throws(() => proRate({ weeklyAmount: 40, days: -1 }), /days must be 0-7/);
  });

  it("computes in integer cents, so float error cannot shift a cent", () => {
    // 0.245 * 100 is 24.499999999999996 in IEEE754 — rounding that directly
    // yields 0.24. Converting to cents first gives the right answer.
    assert.equal(proRate({ weeklyAmount: 0.245, days: 7 }).amount, 0.25);
  });

  it("rounds a refund the same distance as a charge", () => {
    const charge = proRate({ weeklyAmount: 40, days: 3 });
    const refund = proRate({ weeklyAmount: -40, days: 3 });
    assert.equal(charge.amount, 17.14);
    assert.equal(refund.amount, -17.14);
  });
});

describe("proRatePerson — the three rows one person generates", () => {
  it("emits fringe, rent and transportation off their OWN dates", () => {
    // Benavides, Veronica on PD 08.28.2026: fringe 8.19 for 1 day, rent 8.20
    // for 3 days, transport 8.20 for 3 days.
    const rows = proRatePerson({
      housingWeekly: 69.23, transportWeekly: 40,
      housingDate: "2026-08-19", housingDays: 1,
      workedDate: "2026-08-20", workedDays: 3,
      transportDate: "2026-08-20", transportDays: 3,
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.amount), [9.89, 29.67, 17.14]);
    assert.deepEqual(rows.map((r) => r.effectiveDate),
      ["2026-08-19", "2026-08-20", "2026-08-20"]);
  });

  it("omits transportation entirely when it was never charged", () => {
    // Not the same as charging zero — Linoshka waives transport for drivers.
    const rows = proRatePerson({
      housingWeekly: 130, housingDate: "2026-08-19", housingDays: 2,
      workedDate: "2026-08-20", workedDays: 3,
    });
    assert.equal(rows.length, 2);
    assert.ok(!rows.some((r) => r.kind === "transportation"));
  });

  it("emits nothing when there is nothing to pro-rate", () => {
    assert.equal(proRatePerson({}).length, 0);
  });
});

describe("fringeAndRentAgree", () => {
  it("accepts different numbers off different dates", () => {
    const rows = proRatePerson({
      housingWeekly: 69.23, housingDate: "2026-08-19", housingDays: 1,
      workedDate: "2026-08-20", workedDays: 3,
    });
    assert.equal(fringeAndRentAgree(rows), true);
  });

  it("catches rent pro-rated while the fringe was left whole", () => {
    // This is the mistake that puts tie-out 4 out of balance.
    const rows = proRatePerson({
      housingWeekly: 69.23, housingDate: "2026-08-19", housingDays: 7,
      workedDate: "2026-08-20", workedDays: 3,
    });
    assert.equal(fringeAndRentAgree(rows), false);
  });

  it("says nothing when only one of the pair exists", () => {
    assert.equal(fringeAndRentAgree(proRatePerson({
      housingWeekly: 69.23, housingDate: "2026-08-19", housingDays: 1,
    })), true);
  });
});
