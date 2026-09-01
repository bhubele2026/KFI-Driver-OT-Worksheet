import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidPayDate,
  nominalFridayFor,
  payDateFor,
  payDateForWeekOf,
  payDates,
  periodDatesFor,
  isBankHoliday,
} from "../payrollPeriod.js";

describe("pay-date law: Fridays, or the Thursday before a Friday holiday", () => {
  it("an ordinary Friday is a valid pay date", () => {
    assert.ok(isValidPayDate("2026-09-04"));
    assert.ok(isValidPayDate("2026-09-11"));
  });

  it("a holiday Friday is NOT payable — its Thursday is", () => {
    // Christmas 2026 and observed New Year's 2027 both land on Friday.
    assert.ok(!isValidPayDate("2026-12-25"));
    assert.ok(isValidPayDate("2026-12-24"));
    assert.ok(!isValidPayDate("2027-01-01"));
    assert.ok(isValidPayDate("2026-12-31"));
    // Juneteenth 2026 and observed July 4th 2026 — the one KFI's own
    // Holiday Pay records already treat as the holiday.
    assert.ok(isBankHoliday("2026-07-03"));
    assert.ok(!isValidPayDate("2026-07-03"));
    assert.ok(isValidPayDate("2026-07-02"));
  });

  it("scrubbed / arbitrary dates are rejected", () => {
    for (const d of ["2026-09-01", "2026-09-02", "2026-09-06", "2026-09-10", "not-a-date"]) {
      assert.ok(!isValidPayDate(d), d);
    }
    // A Thursday with a perfectly ordinary Friday after it is NOT a pay date.
    assert.ok(!isValidPayDate("2026-09-03"));
  });

  it("Thanksgiving moves nothing — the Friday after is a banking day", () => {
    assert.ok(isBankHoliday("2026-11-26"));
    assert.ok(isValidPayDate("2026-11-27"));
  });
});

describe("period algebra survives a holiday shift", () => {
  it("Thursday 2026-12-24 derives the SAME week as its Friday would", () => {
    const thu = periodDatesFor("2026-12-24");
    const fri = periodDatesFor("2026-12-25");
    assert.equal(thu.weekStart, fri.weekStart);
    assert.equal(thu.ppeDate, fri.ppeDate);
    assert.equal(thu.accountingPeriod, fri.accountingPeriod);
    // The label keeps the REAL pay date — that's what the folder is named for.
    assert.equal(thu.label, "PD 12.24.2026");
  });

  it("regular Fridays are untouched (verified anchor: PD 08.28.2026)", () => {
    const d = periodDatesFor("2026-08-28");
    assert.equal(d.accountingPeriod, "2026-08-23");
    assert.equal(d.ppeDate, "2026-08-22");
    assert.equal(d.weekStart, "2026-08-16");
  });

  it("nominalFridayFor round-trips both directions", () => {
    assert.equal(nominalFridayFor("2026-12-24"), "2026-12-25");
    assert.equal(nominalFridayFor("2026-09-04"), "2026-09-04");
    assert.equal(payDateForWeekOf("2026-12-25"), "2026-12-24");
    assert.equal(payDateForWeekOf("2026-09-04"), "2026-09-04");
  });
});

describe("payDateFor lands on the real pay day", () => {
  it("mid-December week resolves to the Thursday", () => {
    assert.equal(payDateFor("2026-12-21"), "2026-12-24"); // Mon of Christmas week
    assert.equal(payDateFor("2026-12-28"), "2026-12-31"); // Mon of New Year week
    assert.equal(payDateFor("2026-09-01"), "2026-09-04"); // ordinary week
  });
});

describe("payDates — the picker's list", () => {
  it("every option is valid, labeled, and holiday weeks are flagged", () => {
    const opts = payDates("2026-12-01", 4, 6);
    assert.equal(opts.length, 11);
    for (const o of opts) {
      assert.ok(isValidPayDate(o.payDate), o.payDate);
      assert.ok(o.label.startsWith("PD "), o.label);
    }
    const christmas = opts.find((o) => o.payDate === "2026-12-24");
    const newYear = opts.find((o) => o.payDate === "2026-12-31");
    assert.ok(christmas?.holidayShifted);
    assert.ok(newYear?.holidayShifted);
    assert.ok(opts.find((o) => o.payDate === "2026-12-18" && !o.holidayShifted));
  });
});
