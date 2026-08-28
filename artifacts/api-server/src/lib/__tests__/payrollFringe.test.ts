import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFringeRows, removeNoHoursFringe, applyFringeProRations,
  reconcileFringeToDeductions, diagnoseImbalance, mnEsstRateFor,
  FRINGE_CODES, RETRO_FRINGE_CODE, type FringeRow, type MasterExportRow,
} from "../payrollFringe";

const m = (o: Partial<MasterExportRow>): MasterExportRow => ({
  personId: 1, person: "Doe, Jane", customer: "DeLallo Foods",
  transactionCode: "Housing Benefit Supplemental", payUnit: 1, payRate: 69.23, ...o,
});
const f = (o: Partial<FringeRow>): FringeRow => ({
  personId: 1, person: "Doe, Jane", customer: "DeLallo Foods",
  transactionCode: "Housing Benefit Supplemental", payUnit: 1, payRate: 69.23, ...o,
});

describe("buildFringeRows", () => {
  it("keeps only the fringe codes and drops the hours rows", () => {
    const rows = buildFringeRows([
      m({}), m({ transactionCode: "Cell Reimburse", payRate: 25 }),
      m({ transactionCode: "RT", payRate: 18 }), m({ transactionCode: "OT" }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.transactionCode).sort(), [...FRINGE_CODES].sort());
  });

  it("includes retro fringe, which shares the same fate as the current row", () => {
    const rows = buildFringeRows([m({ transactionCode: RETRO_FRINGE_CODE, payRate: 130 })]);
    assert.equal(rows.length, 1);
  });

  it("forces pay unit to 1 — the money lives in the rate", () => {
    const rows = buildFringeRows([m({ payUnit: 7 })]);
    assert.equal(rows[0]!.payUnit, 1);
    assert.equal(rows[0]!.payRate, 69.23);
  });
});

describe("no-hours removal", () => {
  it("removes fringe for someone with no work", () => {
    const out = removeNoHoursFringe([f({ personId: 5 })], [{ personId: 5, reason: "no_work" }]);
    assert.equal(out.rows.length, 0);
    assert.equal(out.carryForward.length, 0);
  });

  it("CARRIES someone housed free to next week rather than dropping them", () => {
    // "If the reason they have no hours is because there is too little work and
    // we are letting them stay in housing for free put these people on the next
    // weeks file so that we can report the housing cost as fringe."
    const out = removeNoHoursFringe([f({ personId: 6 })], [{ personId: 6, reason: "housed_free" }]);
    assert.equal(out.rows.length, 0, "off this week's file");
    assert.equal(out.carryForward.length, 1, "but not lost");
    assert.equal(out.carryForward[0]!.personId, 6);
  });

  it("removes BOTH the current and the retro fringe row for one person", () => {
    const out = removeNoHoursFringe(
      [f({ personId: 7 }), f({ personId: 7, transactionCode: RETRO_FRINGE_CODE, payRate: 130 })],
      [{ personId: 7, reason: "terminated" }]);
    assert.equal(out.rows.length, 0);
    assert.equal(out.removed.length, 2);
  });

  it("leaves everyone else alone", () => {
    const out = removeNoHoursFringe([f({ personId: 8 })], [{ personId: 99, reason: "no_work" }]);
    assert.equal(out.rows.length, 1);
  });
});

describe("fringe pro-ration follows the housing deduction", () => {
  it("applies the SAME math as the deduction", () => {
    // 69.23 over 3 days is 29.67 — identical to the rent pro-rate.
    const out = applyFringeProRations([f({ personId: 3 })], [{ personId: 3, days: 3 }]);
    assert.equal(out.rows[0]!.payRate, 29.67);
    assert.deepEqual(out.changed[0], { personId: 3, was: 69.23, now: 29.67, days: 3 });
  });

  it("leaves a full week alone", () => {
    const out = applyFringeProRations([f({ personId: 3 })], [{ personId: 3, days: 7 }]);
    assert.equal(out.rows[0]!.payRate, 69.23);
    assert.equal(out.changed.length, 0);
  });

  it("does NOT pro-rate a cell reimbursement, which is not housing", () => {
    const out = applyFringeProRations(
      [f({ personId: 3, transactionCode: "Cell Reimburse", payRate: 25 })],
      [{ personId: 3, days: 3 }]);
    assert.equal(out.rows[0]!.payRate, 25);
  });

  it("ignores people with no pro-ration", () => {
    const out = applyFringeProRations([f({ personId: 4 })], [{ personId: 3, days: 2 }]);
    assert.equal(out.rows[0]!.payRate, 69.23);
  });
});

describe("reconciling fringe to the deduction report", () => {
  const rows = [f({ personId: 1 }), f({ personId: 2 }), f({ personId: 3 })];

  it("flags an earning with NO offsetting deduction", () => {
    const r = reconcileFringeToDeductions(rows, [1, 2], "Housing Benefit Supplemental");
    assert.deepEqual(r.earningsWithoutDeduction.map((x) => x.personId), [3]);
    assert.equal(r.matched, 2);
  });

  it("reports a deduction with no earning SEPARATELY — it means something else", () => {
    // Usually a finished retro whose deduction was end-dated while the
    // assignment stayed open. Worth a look, rarely an error.
    const r = reconcileFringeToDeductions(rows, [1, 2, 3, 42], "Housing Benefit Supplemental");
    assert.deepEqual(r.deductionsWithoutEarnings, [42]);
    assert.equal(r.earningsWithoutDeduction.length, 0);
  });

  it("scopes to one code, so retro does not contaminate current", () => {
    const mixed = [f({ personId: 1 }), f({ personId: 9, transactionCode: RETRO_FRINGE_CODE })];
    const r = reconcileFringeToDeductions(mixed, [1], "Housing Benefit Supplemental");
    assert.equal(r.earningsWithoutDeduction.length, 0);
  });
});

describe("diagnoseImbalance — the documented hunt", () => {
  const candidates = [
    { label: "Torres, Angela", amount: 69.23 },
    { label: "Cruz, Maria", amount: 29.67 },
    { label: "Palacios, Diana", amount: 49.45 },
    { label: "Rangel, Obdulia", amount: 9.89 },
  ];

  it("finds the single row that equals the gap", () => {
    const r = diagnoseImbalance(29.67, candidates);
    assert.equal(r.singles.length, 1);
    assert.equal(r.singles[0]!.label, "Cruz, Maria");
  });

  it("finds a PAIR summing to the gap — the case nobody spots by scrolling", () => {
    const r = diagnoseImbalance(39.56, candidates); // 29.67 + 9.89
    assert.equal(r.singles.length, 0);
    assert.equal(r.pairs.length, 1);
    assert.deepEqual(r.pairs[0]!.map((c) => c.label).sort(), ["Cruz, Maria", "Rangel, Obdulia"]);
  });

  it("works on a negative discrepancy — direction does not change the search", () => {
    assert.equal(diagnoseImbalance(-29.67, candidates).singles[0]!.label, "Cruz, Maria");
  });

  it("returns nothing rather than a false lead", () => {
    const r = diagnoseImbalance(1000, candidates);
    assert.equal(r.singles.length, 0);
    assert.equal(r.pairs.length, 0);
  });
});

describe("MN ESST rate", () => {
  it("takes the rate from the RT row, not a fringe row", () => {
    // Taking it from a fringe row pays sick time at 69.23 an hour.
    const master = [
      m({ personId: 1, transactionCode: "RT", payRate: 18.5 }),
      m({ personId: 1, transactionCode: "Housing Benefit Supplemental", payRate: 69.23 }),
    ];
    assert.equal(mnEsstRateFor(master, 1), 18.5);
  });

  it("returns null when there is no RT row to take it from", () => {
    assert.equal(mnEsstRateFor([m({ personId: 1 })], 1), null);
  });
});
