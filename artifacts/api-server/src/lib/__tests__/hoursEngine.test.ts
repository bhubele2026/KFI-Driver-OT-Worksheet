import test from "node:test";
import assert from "node:assert/strict";
import type { Punch } from "@workspace/db/schema";
import { computeDriverTotals } from "../hoursEngine.js";

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
