import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSummaryChecks,
  checksEq,
  sumPunchHours,
  CHECK_EPSILON,
  type SummaryCheckLabels,
  type SummaryTotalsLike,
} from "../summaryChecks.ts";

// Labels are passed through opaquely by the helper. The translation
// lookup happens in driver-detail.tsx; the helper itself only needs
// strings to attach to each check row.
const LABELS: SummaryCheckLabels = {
  totalEq: "Total = Driver + Customer",
  customerEq: "Customer = Total − Driver",
  driverEq: "Driver = Total − Customer",
  rtEq: "Customer RT + Driver RT = RT",
  otEq: "Customer OT + Driver OT = OT",
  rtPlusOtEq: "RT + OT = Total",
  rowSumEq: "Total Hours = Running total (last row)",
};

// Internally consistent totals for a 42h week — 35h customer + 7h driver,
// 40h RT + 2h OT. These mirror what the server's hours engine returns.
const TOTALS: SummaryTotalsLike = {
  driverHours: 7,
  customerHours: 35,
  totalHours: 42,
  regularHours: 40,
  overtimeHours: 2,
  driverRt: 5,
  driverOt: 2,
  custRt: 35,
  custOt: 0,
};

test("rowSumEq check passes when row hours match Total Hours", () => {
  const checks = buildSummaryChecks({
    totals: TOTALS,
    rowHoursSum: 42,
    labels: LABELS,
  });
  // The row-sum check is the seventh entry, appended after the existing six
  // identities so the original checks keep their indices/test ids.
  assert.equal(checks.length, 7);
  const rowSum = checks[6];
  assert.equal(rowSum.key, "total-row-sum");
  assert.equal(rowSum.label, LABELS.rowSumEq);
  assert.equal(rowSum.expected, 42);
  assert.equal(rowSum.actual, 42);
  // Every check reconciles → card stays in the "all reconcile" state.
  assert.ok(checks.every((c) => checksEq(c.expected, c.actual)));
});

test("rowSumEq passes when difference is below the 0.015 tolerance", () => {
  const checks = buildSummaryChecks({
    totals: TOTALS,
    rowHoursSum: 42 + 0.01,
    labels: LABELS,
  });
  const rowSum = checks[6];
  assert.ok(checksEq(rowSum.expected, rowSum.actual));
  assert.ok(checks.every((c) => checksEq(c.expected, c.actual)));
});

test("rowSumEq fails and flips card to mismatch when rows diverge from total", () => {
  const checks = buildSummaryChecks({
    totals: TOTALS,
    rowHoursSum: 41.5,
    labels: LABELS,
  });
  const rowSum = checks[6];
  assert.equal(rowSum.actual, 41.5);
  assert.equal(rowSum.expected, 42);
  assert.equal(checksEq(rowSum.expected, rowSum.actual), false);
  // The card flips to "mismatch" the moment any check fails.
  assert.equal(checks.every((c) => checksEq(c.expected, c.actual)), false);
  // The other six identity checks are unaffected by row-sum drift.
  for (let i = 0; i < 6; i++) {
    assert.ok(
      checksEq(checks[i].expected, checks[i].actual),
      `pre-existing check ${checks[i].key} should still reconcile`,
    );
  }
});

test("CHECK_EPSILON matches the legacy 0.015 threshold", () => {
  assert.equal(CHECK_EPSILON, 0.015);
  assert.equal(checksEq(1, 1 + 0.014), true);
  assert.equal(checksEq(1, 1 + 0.016), false);
});

test("sumPunchHours coerces string and missing hours the same way the table does", () => {
  assert.equal(
    sumPunchHours([{ hours: "1.25" }, { hours: 2.5 }, { hours: "0" }]),
    3.75,
  );
  // Non-numeric / empty strings fall back to 0, mirroring `Number(p.hours) || 0`.
  assert.equal(
    sumPunchHours([{ hours: "" }, { hours: "abc" as unknown as string }, { hours: 1 }]),
    1,
  );
});
