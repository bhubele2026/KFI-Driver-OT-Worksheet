import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summaryIsFaithful } from "../payrollSummaryFaithful.js";

describe("summary faithfulness — the mechanical guard behind the AI pass", () => {
  const action =
    "Enter 10.00 hrs MN-ESST for w/e 8/29 at rate 20.50 — do NOT also enter the 8.00 requested on 8/18";

  it("accepts a label whose numbers all come from the source", () => {
    assert.ok(summaryIsFaithful(action, "Enter 10.00 hrs MN-ESST, not the 8.00"));
  });

  it("rejects an invented or reformatted number", () => {
    assert.ok(!summaryIsFaithful(action, "Enter 10 hrs MN-ESST, not the 8.00")); // 10 ≠ 10.00 — exact tokens only
    assert.ok(!summaryIsFaithful(action, "Enter 11.00 hrs MN-ESST, not 8.00"));
    assert.ok(!summaryIsFaithful(action, "Enter 10.00 hrs at 20.5, not 8.00"));
  });

  it("rejects a label that lost the negation", () => {
    assert.ok(!summaryIsFaithful(action, "Enter 10.00 hrs MN-ESST for 8/29"));
  });

  it("rejects the dropped-rate case (20.50 vanishing is fine — dropping is allowed, changing is not)", () => {
    assert.ok(summaryIsFaithful(action, "Enter 10.00 hrs, not the 8.00"));
  });

  it("plain positive actions need no negation", () => {
    assert.ok(summaryIsFaithful("Enter 3.50 Driver OT hours for w/e 8/29", "Enter 3.50 Driver OT (w/e 8/29)"));
  });

  it("rejects an over-long label", () => {
    assert.ok(!summaryIsFaithful("Close the assignment", "x".repeat(120)));
  });
});
