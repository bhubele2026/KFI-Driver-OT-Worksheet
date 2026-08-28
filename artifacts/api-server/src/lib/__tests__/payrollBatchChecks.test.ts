import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkOutliers, checkLiveChecks, checkVoidsAndReversals, checkGrossToNet,
  checkTaxWithheld, checkSingleBatch, batchTotals, runBatchChecks,
  OUTLIER_LOW, OUTLIER_HIGH, type RegisterRow,
} from "../payrollBatchChecks";

const r = (o: Partial<RegisterRow>): RegisterRow => ({
  PersonId: 1, Name: "DOE, JANE", CheckNumber: "12345", Gross: 1000,
  Net: 800, Tax: 150, Deduction: 50, Reimbursement: 0, Advance: 0,
  IsLiveCheck: false, TotalPayHours: 40, PaymentBatchId: 919, ...o,
});

describe("outliers", () => {
  it("flags both ends of the documented range", () => {
    const c = checkOutliers([r({ Net: 27.49 }), r({ PersonId: 2, Net: 2500 }), r({ PersonId: 3, Net: 800 })]);
    assert.equal(c.detail.length, 2);
    assert.equal(c.status, "warn");
  });

  it("WARNS rather than fails — a part week is legitimately small", () => {
    // Diana Palacios really did net 27.49 on 5.75 hours in the reference week.
    // Blocking on that would train people to click past the check.
    assert.equal(checkOutliers([r({ Net: 27.49, TotalPayHours: 5.75 })]).status, "warn");
  });

  it("uses the documented bounds", () => {
    assert.equal(OUTLIER_LOW, 300);
    assert.equal(OUTLIER_HIGH, 2000);
    assert.equal(checkOutliers([r({ Net: OUTLIER_LOW })]).detail.length, 0);
    assert.equal(checkOutliers([r({ Net: OUTLIER_HIGH })]).detail.length, 0);
  });

  it("ignores a zero payment, which is a different problem", () => {
    assert.equal(checkOutliers([r({ Net: 0 })]).detail.length, 0);
  });
});

describe("live checks", () => {
  it("reports them as info — they are a task, not a fault", () => {
    const c = checkLiveChecks([r({ IsLiveCheck: true })]);
    assert.equal(c.status, "info");
    assert.equal(c.detail.length, 1);
  });
  it("passes an all-ACH run", () => {
    assert.equal(checkLiveChecks([r({})]).status, "pass");
  });
});

describe("voids and reversals", () => {
  it("finds a V or R check number", () => {
    const c = checkVoidsAndReversals([r({ CheckNumber: "V1234" }), r({ CheckNumber: "R99" })]);
    assert.equal(c.detail.length, 2);
  });
  it("does not flag an ordinary numeric check", () => {
    assert.equal(checkVoidsAndReversals([r({ CheckNumber: "12345" })]).status, "pass");
  });
});

describe("gross to net", () => {
  it("passes a row that reconciles", () => {
    // 1000 + 0 - 150 - 50 - 0 = 800
    assert.equal(checkGrossToNet([r({})]).status, "pass");
  });

  it("FAILS a row where a component was missed", () => {
    const c = checkGrossToNet([r({ Net: 850 })]);
    assert.equal(c.status, "fail");
    assert.equal((c.detail[0] as { diff: number }).diff, -50);
  });

  it("counts reimbursement and advance the right way round", () => {
    // A reimbursement raises net; an advance lowers it.
    assert.equal(checkGrossToNet([r({ Reimbursement: 100, Net: 900 })]).status, "pass");
    assert.equal(checkGrossToNet([r({ Advance: 100, Net: 700 })]).status, "pass");
  });
});

describe("tax withheld", () => {
  it("flags a paid person with zero tax", () => {
    const c = checkTaxWithheld([r({ Tax: 0 })]);
    assert.equal(c.status, "warn");
  });

  it("respects a known exemption but keeps checking everyone else", () => {
    // Yvon Agustin, a WI resident on a non-taxable KY code, is legitimate.
    // Suppressing the whole check instead would hide a real new one.
    const c = checkTaxWithheld(
      [r({ PersonId: 55, Tax: 0 }), r({ PersonId: 66, Tax: 0 })],
      { knownExempt: new Set([55]) });
    assert.equal(c.detail.length, 1);
    assert.equal((c.detail[0] as { personId: number }).personId, 66);
  });

  it("calls out Pennsylvania specifically", () => {
    const c = checkTaxWithheld([r({ PersonId: 7, Tax: 0 })], { paPersonIds: new Set([7]) });
    assert.match(c.message, /Pennsylvania/);
  });

  it("ignores an unpaid row", () => {
    assert.equal(checkTaxWithheld([r({ Gross: 0, Tax: 0 })]).status, "pass");
  });
});

describe("batch shape", () => {
  it("passes a single batch and names it", () => {
    const c = checkSingleBatch([r({}), r({ PersonId: 2 })]);
    assert.equal(c.status, "pass");
    assert.match(c.message, /919/);
  });

  it("warns on several batches without calling it wrong", () => {
    // PD 08.21.2026 legitimately carried three.
    const c = checkSingleBatch([r({ PaymentBatchId: 912 }), r({ PaymentBatchId: 913 })]);
    assert.equal(c.status, "warn");
    assert.match(c.message, /accelerated week/);
  });

  it("totals the run", () => {
    const c = batchTotals([r({}), r({ PersonId: 2, Gross: 500, Net: 400, Tax: 75, Deduction: 25 })]);
    const t = c.detail[0] as { payments: number; gross: number; net: number };
    assert.equal(t.payments, 2);
    assert.equal(t.gross, 1500);
    assert.equal(t.net, 1200);
  });
});

describe("runBatchChecks", () => {
  it("returns the whole Wednesday set", () => {
    assert.equal(runBatchChecks([r({})]).length, 7);
  });

  it("a clean run raises nothing worse than info", () => {
    const out = runBatchChecks([r({}), r({ PersonId: 2 })]);
    assert.ok(out.every((c) => c.status === "pass" || c.status === "info"),
      JSON.stringify(out.filter((c) => c.status !== "pass" && c.status !== "info")));
  });
});
