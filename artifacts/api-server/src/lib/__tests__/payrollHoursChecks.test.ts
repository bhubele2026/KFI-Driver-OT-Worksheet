import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkNoLongShifts, applyPunchExclusions, checkTimesheetVsPunches,
  checkPerPersonTotals, checkNameAlignment, checkDuplicateCodeRows,
  checkRtOtSplit, runHoursChecks, MAX_DAILY_HOURS, TIE_TOLERANCE,
} from "../payrollHoursChecks";

describe("the 13-hour guard", () => {
  it("passes a normal day", () => {
    assert.equal(checkNoLongShifts([{ employee: "A", hours: 10.5 }]).status, "pass");
  });

  it("WARNS on a 24-hour shift and names it", () => {
    // A missed clock-out records as 24 hours. Real, and it has happened.
    const r = checkNoLongShifts([
      { employee: "Doe, Jane", hours: 24, date: "2026-08-18" },
      { employee: "Other", hours: 8 },
    ]);
    assert.equal(r.status, "warn");
    assert.equal((r.detail[0] as { employee: string }).employee, "Doe, Jane");
  });

  it("warns rather than fails — 13+ is unusual, not impossible", () => {
    assert.equal(checkNoLongShifts([{ employee: "A", hours: MAX_DAILY_HOURS + 0.5 }]).status, "warn");
    assert.equal(checkNoLongShifts([{ employee: "A", hours: MAX_DAILY_HOURS }]).status, "pass");
  });
});

describe("PREM exclusion — Trienda only", () => {
  const punches = [
    { employee: "A", hours: 8, payCategory: "Regular" },
    { employee: "A", hours: 2, payCategory: "PREM Shift" },
  ];

  it("drops PREM for Trienda", () => {
    assert.equal(applyPunchExclusions(punches, "Trienda Holdings").length, 1);
  });

  it("KEEPS PREM for Penda — applying Trienda's filter here removes real hours", () => {
    assert.equal(applyPunchExclusions(punches, "Penda Corp").length, 2);
  });

  it("leaves every other customer untouched", () => {
    assert.equal(applyPunchExclusions(punches, "Adient").length, 2);
  });
});

describe("timesheet vs daily punches", () => {
  it("allows the documented 0.05 rounding tolerance", () => {
    const r = checkTimesheetVsPunches(
      [{ employee: "A", hours: 40 }], [{ employee: "A", hours: 39.96 }], "Adient");
    assert.equal(r.status, "pass");
  });

  it("fails past the tolerance", () => {
    const r = checkTimesheetVsPunches(
      [{ employee: "A", hours: 40 }], [{ employee: "A", hours: 39.5 }], "Adient");
    assert.equal(r.status, "fail");
  });

  it("ties for Trienda ONLY once PREM is excluded", () => {
    const ts = [{ employee: "A", hours: 40 }];
    const punches = [
      { employee: "A", hours: 40, payCategory: "Regular" },
      { employee: "A", hours: 6, payCategory: "PREM" },
    ];
    assert.equal(checkTimesheetVsPunches(ts, punches, "Trienda Holdings").status, "pass");
    // The same data for Penda genuinely does not tie, and should say so.
    assert.equal(checkTimesheetVsPunches(ts, punches, "Penda Corp").status, "fail");
  });

  it("says how many rows it excluded, so a pass is explicable", () => {
    const r = checkTimesheetVsPunches(
      [{ employee: "A", hours: 40 }],
      [{ employee: "A", hours: 40, payCategory: "Reg" }, { employee: "A", hours: 6, payCategory: "prem" }],
      "Trienda Holdings");
    assert.match(r.message, /1 punch rows excluded/);
  });
});

describe("per-person totals", () => {
  it("names who disagrees rather than just failing", () => {
    const r = checkPerPersonTotals(
      [{ employee: "Doe, Jane", hours: 40 }, { employee: "Roe, Sam", hours: 32 }],
      [{ employee: "Doe, Jane", hours: 40 }, { employee: "Roe, Sam", hours: 30 }],
      "Adient");
    assert.equal(r.status, "fail");
    assert.equal(r.detail.length, 1);
    assert.match(String((r.detail[0] as { employee: string }).employee), /roe sam/);
  });

  it("sums a person's several punch rows before comparing", () => {
    const r = checkPerPersonTotals(
      [{ employee: "Doe, Jane", hours: 16 }],
      [{ employee: "Doe, Jane", hours: 8 }, { employee: "Doe, Jane", hours: 8 }],
      "Adient");
    assert.equal(r.status, "pass");
  });
});

describe("name alignment — the check that stops paying the wrong person", () => {
  it("passes when the rows line up", () => {
    assert.equal(
      checkNameAlignment(["Doe, Jane", "Roe, Sam"], ["Doe, Jane", "Roe, Sam"]).status, "pass");
  });

  it("FAILS on an off-by-one even though both lists hold the same names", () => {
    // This is the real failure: same people, shifted by a row, and the overtime
    // lands on the wrong one. A set comparison would call this fine.
    const r = checkNameAlignment(
      ["Doe, Jane", "Roe, Sam", "Poe, Alex"],
      ["Roe, Sam", "Poe, Alex", "Doe, Jane"]);
    assert.equal(r.status, "fail");
    assert.equal(r.detail.length, 3);
  });

  it("FAILS on differing row counts and says which names are unmatched", () => {
    const r = checkNameAlignment(["Doe, Jane", "Roe, Sam"], ["Doe, Jane"]);
    assert.equal(r.status, "fail");
    assert.match(r.message, /row counts differ/);
    assert.deepEqual((r.detail[0] as { onlyInTemplate: string[] }).onlyInTemplate, ["roe sam"]);
  });

  it("ignores punctuation and casing drift in a name", () => {
    assert.equal(checkNameAlignment(["Rangel , Obdulia"], ["rangel obdulia"]).status, "pass");
  });
});

describe("duplicate code rows", () => {
  it("flags two Reg lines for one person as something to COMBINE", () => {
    const r = checkDuplicateCodeRows([
      { employee: "Doe, Jane", hours: 20, transactionCode: "RT", shift: "1" },
      { employee: "Doe, Jane", hours: 20, transactionCode: "RT", shift: "2" },
    ]);
    assert.equal(r.status, "warn");
    assert.equal((r.detail[0] as { combinedHours: number }).combinedHours, 40);
  });

  it("does not flag the same person on different codes", () => {
    assert.equal(checkDuplicateCodeRows([
      { employee: "A", hours: 40, transactionCode: "RT" },
      { employee: "A", hours: 5, transactionCode: "OT" },
    ]).status, "pass");
  });
});

describe("RT + OT must equal the total", () => {
  it("passes when it balances", () => {
    assert.equal(checkRtOtSplit(45, 40, 5).status, "pass");
  });
  it("fails when it does not", () => {
    const r = checkRtOtSplit(45, 40, 4);
    assert.equal(r.status, "fail");
    assert.match(r.message, /diff 1/);
  });
});

describe("runHoursChecks", () => {
  it("runs the whole Monday set and keeps the tolerance visible", () => {
    const out = runHoursChecks({
      customer: "Trienda Holdings",
      timesheet: [{ employee: "Doe, Jane", hours: 40, transactionCode: "RT" }],
      // Daily punches are DAILY — five eights, not a weekly total. Feeding a
      // weekly figure here trips the 13-hour guard, which is the guard working.
      punches: [
        { employee: "Doe, Jane", hours: 8, payCategory: "Regular", date: "2026-08-17" },
        { employee: "Doe, Jane", hours: 8, payCategory: "Regular", date: "2026-08-18" },
        { employee: "Doe, Jane", hours: 8, payCategory: "Regular", date: "2026-08-19" },
        { employee: "Doe, Jane", hours: 8, payCategory: "Regular", date: "2026-08-20" },
        { employee: "Doe, Jane", hours: 8, payCategory: "Regular", date: "2026-08-21" },
        { employee: "Doe, Jane", hours: 6, payCategory: "PREM", date: "2026-08-21" },
      ],
      templateNames: ["Doe, Jane"],
      reportedTotal: 40, reportedRt: 40, reportedOt: 0,
    });
    assert.equal(out.length, 6);
    assert.ok(out.every((c) => c.status === "pass"), JSON.stringify(out.filter((c) => c.status !== "pass")));
    assert.ok(TIE_TOLERANCE === 0.05);
  });
});
