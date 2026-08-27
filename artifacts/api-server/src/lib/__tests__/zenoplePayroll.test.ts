import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sumDeduction, FRINGE_OFFSET_CODE, RETRO_FRINGE_OFFSET_CODE } from "../zenoplePayroll";

const d = (o: Record<string, unknown>) => ({
  AccountingPeriod: "2026-08-23T00:00:00",
  TransactionCode: FRINGE_OFFSET_CODE,
  Adjustment: 100,
  Deduction: 999,
  PaymentAdjustmentId: 1,
  ...o,
});

describe("sumDeduction", () => {
  it("sums Adjustment, never Deduction", () => {
    // On the reference week these differ sharply: 722.71 vs 2589.37. Summing
    // the wrong column makes an exact tie-out fail for no visible reason.
    assert.equal(sumDeduction([d({})], "2026-08-23", FRINGE_OFFSET_CODE), 100);
  });

  it("dedupes on PaymentAdjustmentId — a repeated row must not double-count", () => {
    const rows = [d({ PaymentAdjustmentId: 7 }), d({ PaymentAdjustmentId: 7 })];
    assert.equal(sumDeduction(rows, "2026-08-23", FRINGE_OFFSET_CODE), 100);
  });

  it("keeps genuinely distinct rows", () => {
    const rows = [d({ PaymentAdjustmentId: 1 }), d({ PaymentAdjustmentId: 2 })];
    assert.equal(sumDeduction(rows, "2026-08-23", FRINGE_OFFSET_CODE), 200);
  });

  it("ignores other accounting periods", () => {
    const rows = [d({}), d({ AccountingPeriod: "2026-08-16T00:00:00", PaymentAdjustmentId: 9 })];
    assert.equal(sumDeduction(rows, "2026-08-23", FRINGE_OFFSET_CODE), 100);
  });

  it("ignores other deduction codes — Housing rent is not the fringe offset", () => {
    const rows = [d({}), d({ TransactionCode: "Housing", PaymentAdjustmentId: 5, Adjustment: 175 })];
    assert.equal(sumDeduction(rows, "2026-08-23", FRINGE_OFFSET_CODE), 100);
  });

  it("keeps retro separate from current", () => {
    const rows = [
      d({}),
      d({ TransactionCode: RETRO_FRINGE_OFFSET_CODE, PaymentAdjustmentId: 3, Adjustment: 130 }),
    ];
    assert.equal(sumDeduction(rows, "2026-08-23", FRINGE_OFFSET_CODE), 100);
    assert.equal(sumDeduction(rows, "2026-08-23", RETRO_FRINGE_OFFSET_CODE), 130);
  });

  it("still counts rows with no PaymentAdjustmentId rather than dropping them", () => {
    const rows = [d({ PaymentAdjustmentId: null }), d({ PaymentAdjustmentId: null })];
    assert.equal(sumDeduction(rows, "2026-08-23", FRINGE_OFFSET_CODE), 200);
  });
});
