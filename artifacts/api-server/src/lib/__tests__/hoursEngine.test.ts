import test from "node:test";
import assert from "node:assert/strict";
import type { Punch } from "@workspace/db/schema";
import { computeDailyTotals, computeDriverTotals } from "../hoursEngine.js";

// Build a synthetic Punch row. Only the fields the engine reads matter:
// `clockIn` (for chronological ordering), `hours`, and `source`.
function p(opts: {
  clockIn: string;
  hours: number;
  source: "Driver" | "Customer";
  date?: string;
}): Punch {
  return {
    id: 0,
    weekStart: "2026-01-05",
    kfiId: "TEST",
    customer: "Test",
    source: opts.source,
    date: opts.date ?? opts.clockIn.slice(0, 10),
    clockIn: opts.clockIn,
    clockOut: opts.clockIn,
    hours: String(opts.hours),
    payType: null,
    dispTz: "America/Chicago",
    isManual: false,
    edited: false,
    ctExternalKey: null,
    fileOrigin: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Punch;
}

// Smoke test for the per-source RT/OT split surfaced on the per-driver page
// (task #67). Mirrors Tiana's reported failure case where a Driver shift
// straddles the 40h boundary: the portion before 40h must be credited to
// Driver RT and the portion after must be credited to Driver OT, with the
// Customer punches that bracket it splitting the remainder.
test("computeDriverTotals splits a Driver shift across the 40h OT boundary", () => {
  // Customer 35.39h, then Driver 6.54h (running 35.39 → 41.93, crosses 40),
  // then Customer 12.68h (running 41.93 → 54.61, all OT).
  // Expected: Driver RT 4.61, Driver OT 1.93, RT 35.39 + 4.61 = 40,
  // OT 1.93 + 12.68 = 14.61.
  const punches = [
    p({ clockIn: "2026-01-05 8:00 AM", hours: 35.39, source: "Customer" }),
    p({ clockIn: "2026-01-08 9:00 AM", hours: 6.54, source: "Driver" }),
    p({ clockIn: "2026-01-09 10:00 AM", hours: 12.68, source: "Customer" }),
  ];
  const t = computeDriverTotals(punches);

  assert.equal(t.totalDriver, 6.54);
  assert.equal(t.totalCustomer, 48.07);
  assert.equal(t.driverRt, 4.61);
  assert.equal(t.driverOt, 1.93);
  assert.equal(t.regularHours, 40.0);
  assert.equal(t.overtimeHours, 14.61);
  assert.equal(t.totalHours, 54.61);
  // Independent re-derivation must match the engine output.
  assert.ok(Math.abs(t.regularHours + t.overtimeHours - t.totalHours) < 0.005);
  assert.ok(Math.abs(t.driverRt + t.driverOt - t.totalDriver) < 0.005);
  assert.ok(Math.abs(t.custRt + t.custOt - t.totalCustomer) < 0.005);
});

test("computeDriverTotals: under 40h has zero OT and per-source RT matches totals", () => {
  const punches = [
    p({ clockIn: "2026-01-05 8:00 AM", hours: 8, source: "Driver" }),
    p({ clockIn: "2026-01-06 8:00 AM", hours: 10, source: "Customer" }),
    p({ clockIn: "2026-01-07 8:00 AM", hours: 7, source: "Driver" }),
  ];
  const t = computeDriverTotals(punches);
  assert.equal(t.totalHours, 25);
  assert.equal(t.regularHours, 25);
  assert.equal(t.overtimeHours, 0);
  assert.equal(t.driverRt, 15);
  assert.equal(t.driverOt, 0);
  assert.equal(t.custRt, 10);
  assert.equal(t.custOt, 0);
  assert.equal(t.hasOvertime, false);
});

// Regression for task #113: dispatcher-reported "5.43 vs 5.47" rounding
// discrepancy. The engine used to round each chronological bucket
// independently to 2dp, so a sum of 2-decimal punches (matching what
// Connecteam shows the driver) could land 0.01–0.04 off in totalHours.
// Pinning totalHours to round(sum, 2) and deriving the rest by subtraction
// keeps the dashboard in lock-step with Connecteam's per-shift totals.
test("computeDriverTotals: per-punch 2dp inputs reconcile to Connecteam-style total", () => {
  // Six shifts that, summed, are exactly 36.13 in 2dp arithmetic but
  // 36.13000000000001 in float arithmetic — the kind of carry that used
  // to surface as 36.12 vs 36.13 in random spots on the dashboard.
  const punches = [
    p({ clockIn: "2026-01-05 8:00 AM", hours: 5.47, source: "Driver" }),
    p({ clockIn: "2026-01-06 8:00 AM", hours: 5.47, source: "Driver" }),
    p({ clockIn: "2026-01-07 8:00 AM", hours: 5.47, source: "Driver" }),
    p({ clockIn: "2026-01-08 8:00 AM", hours: 5.47, source: "Driver" }),
    p({ clockIn: "2026-01-09 8:00 AM", hours: 5.47, source: "Driver" }),
    p({ clockIn: "2026-01-10 8:00 AM", hours: 8.78, source: "Driver" }),
  ];
  const t = computeDriverTotals(punches);
  // Connecteam-side total: 5.47*5 + 8.78 = 36.13.
  assert.equal(t.totalDriver, 36.13);
  assert.equal(t.totalHours, 36.13);
  assert.equal(t.regularHours, 36.13);
  assert.equal(t.overtimeHours, 0);
  assert.equal(t.driverRt, 36.13);
  assert.equal(t.driverOt, 0);
});

// Regression for task #113: when a manual adjustment crosses the 40h
// boundary and the chronological RT bucket lands on a 2dp boundary, the
// 0.01 rounding delta used to silently inflate OT (because each bucket
// was rounded independently). Anchoring on driverRt and subtracting
// distributes the delta proportionally — driverOt = totalDriver - driverRt
// — so the dispatcher's edit produces a payroll-correct split.
test("computeDriverTotals: rounding delta near 40h is absorbed into RT, not pushed into OT", () => {
  // Three Driver shifts whose float sum is 40.005 (rounds to 40.01 at 2dp).
  // Naive r2(rt) + r2(ot) used to yield 40.00 + 0.01 = 40.01 (correct sum)
  // but with rt = chronological 40.000 and ot = chronological 0.005 — i.e.
  // the entire rounding delta landed in OT. We want regularHours = 40.00
  // and overtimeHours = 0.01 when the float sum is 40.005, not the other
  // way around.
  const punches = [
    p({ clockIn: "2026-01-05 8:00 AM", hours: 13.335, source: "Driver" }),
    p({ clockIn: "2026-01-06 8:00 AM", hours: 13.335, source: "Driver" }),
    p({ clockIn: "2026-01-07 8:00 AM", hours: 13.335, source: "Driver" }),
  ];
  const t = computeDriverTotals(punches);
  assert.equal(t.totalDriver, 40.01);
  assert.equal(t.totalHours, 40.01);
  // RT pinned at 40 (the OT threshold), OT picks up the 0.01 delta — but
  // crucially, totalDriver === driverRt + driverOt exactly, with no extra
  // rounding artifact in the per-source split.
  assert.equal(t.regularHours, 40.0);
  assert.equal(t.overtimeHours, 0.01);
  assert.equal(t.driverRt, 40.0);
  assert.equal(t.driverOt, 0.01);
  assert.equal(Math.round((t.driverRt + t.driverOt) * 100) / 100, t.totalDriver);
});

// Daily totals must reconcile per-day too: rt + ot === total for every
// row. The dispatcher cross-checks this by hand at payroll time and a
// 0.01 drift looks like a missing half-minute of work.
test("computeDailyTotals: per-day rt + ot reconciles to per-day total", () => {
  const punches = [
    p({ clockIn: "2026-01-05 8:00 AM", hours: 8.07, source: "Driver", date: "2026-01-05" }),
    p({ clockIn: "2026-01-06 8:00 AM", hours: 9.13, source: "Customer", date: "2026-01-06" }),
    p({ clockIn: "2026-01-07 8:00 AM", hours: 8.27, source: "Driver", date: "2026-01-07" }),
    p({ clockIn: "2026-01-08 8:00 AM", hours: 9.47, source: "Customer", date: "2026-01-08" }),
    p({ clockIn: "2026-01-09 8:00 AM", hours: 8.13, source: "Driver", date: "2026-01-09" }),
  ];
  const daily = computeDailyTotals(punches, "2026-01-05", "2026-01-11");
  for (const d of daily) {
    assert.equal(
      Math.round((d.regularHours + d.overtimeHours) * 100) / 100,
      d.totalHours,
      `day ${d.date}: ${d.regularHours} + ${d.overtimeHours} != ${d.totalHours}`,
    );
    assert.equal(
      Math.round((d.driverHours + d.customerHours) * 100) / 100,
      d.totalHours,
      `day ${d.date}: driver+customer != total`,
    );
  }
});
