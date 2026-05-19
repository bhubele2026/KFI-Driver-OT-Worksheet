import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyParity,
  computeBaselineStaleness,
  summarizeParity,
} from "../connecteamParity.js";

// Helper: build a DailyTotalLite. By default customerHours=0 so existing
// CT-only test scenarios behave the same as before.
const dt = (
  date: string,
  totalHours: number,
  customerHours = 0,
): { date: string; totalHours: number; customerHours: number } => ({
  date,
  totalHours,
  customerHours,
});

test("buildDailyParity: CT-only days — dashboard matches CT within 0.005h", () => {
  const daily = [dt("2026-01-05", 8.5), dt("2026-01-06", 8.51), dt("2026-01-07", 9.0)];
  const snapshot = [
    { date: "2026-01-05", hours: "8.50" },
    { date: "2026-01-06", hours: "8.50" },
    { date: "2026-01-07", hours: "9.00" },
  ];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, false);
  assert.equal(parity[1].connecteamHours, 8.5);
  assert.equal(parity[1].customerHours, 0);
  assert.equal(parity[1].dashboardHours, 8.51);
  assert.equal(parity[2].matches, true);
  const sum = summarizeParity(parity);
  assert.equal(sum.status, "differ");
  assert.equal(sum.diffCount, 1);
});

test("buildDailyParity: Customer-only day (no CT shifts) — match iff dashboard == customer", () => {
  // Driver had no Connecteam shifts on 1/6, but customer file imported 4h.
  // Dashboard should equal customer hours → match. If dashboard diverges
  // from customer (e.g. dispatcher added a manual Driver punch on top),
  // that's a real diff.
  const daily = [
    dt("2026-01-05", 8, 0), // CT-only, match
    dt("2026-01-06", 4, 4), // Customer-only, dashboard==customer → match
    dt("2026-01-07", 6, 4), // Customer 4 + manual Driver 2 → dashboard 6, CT 0 → diff
  ];
  const snapshot = [{ date: "2026-01-05", hours: "8.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, true);
  assert.equal(parity[1].connecteamHours, 0);
  assert.equal(parity[2].matches, false);
  assert.equal(parity[2].connecteamHours, 0);
  assert.equal(parity[2].customerHours, 4);
  assert.equal(parity[2].dashboardHours, 6);
  assert.deepEqual(summarizeParity(parity), { status: "differ", diffCount: 1 });
});

test("buildDailyParity: both present — dashboard matches (CT + Customer)", () => {
  const daily = [
    dt("2026-01-05", 10, 4), // CT 6 + Cust 4 = 10 → match
    dt("2026-01-06", 12, 4), // CT 8 + Cust 4 = 12 → match
  ];
  const snapshot = [
    { date: "2026-01-05", hours: "6.00" },
    { date: "2026-01-06", hours: "8.00" },
  ];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, true);
  assert.deepEqual(summarizeParity(parity), { status: "match", diffCount: 0 });
});

test("buildDailyParity: both present — dashboard diverges from (CT + Customer)", () => {
  // CT 6 + Cust 4 = 10, but dashboard reports 11 → diff (an edited or extra
  // punch crept in somewhere). Tooltip should make all three numbers visible.
  const daily = [dt("2026-01-05", 11, 4)];
  const snapshot = [{ date: "2026-01-05", hours: "6.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, false);
  assert.equal(parity[0].connecteamHours, 6);
  assert.equal(parity[0].customerHours, 4);
  assert.equal(parity[0].dashboardHours, 11);
  assert.deepEqual(summarizeParity(parity), { status: "differ", diffCount: 1 });
});

test("buildDailyParity: when no baseline yet, every day is unknown (badge stays neutral)", () => {
  const daily = [dt("2026-01-05", 8.5, 4), dt("2026-01-06", 0)];
  const parity = buildDailyParity(daily, [], false);
  assert.equal(parity[0].matches, null);
  assert.equal(parity[0].connecteamHours, null);
  assert.equal(parity[0].customerHours, 4);
  assert.equal(parity[0].dashboardHours, 8.5);
  assert.equal(parity[1].matches, null);
  assert.deepEqual(summarizeParity(parity), { status: "unknown", diffCount: 0 });
});

test("buildDailyParity: AFTER refresh, a day with no snapshot row but a manual punch is a real diff", () => {
  // Reviewer-flagged regression: refresh only writes snapshot rows for days
  // Connecteam reported shifts. If the dispatcher then adds a manual punch
  // on a different day with no matching customer hours, the parity badge
  // MUST go amber.
  const daily = [
    dt("2026-01-05", 8, 0), // CT 8, dashboard 8 → match
    dt("2026-01-06", 4, 0), // manual Driver punch, no CT, no customer → diff
  ];
  const snapshot = [{ date: "2026-01-05", hours: "8.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, false, "manual punch with no CT/customer must be a diff");
  assert.equal(parity[1].connecteamHours, 0);
  assert.deepEqual(summarizeParity(parity), { status: "differ", diffCount: 1 });
});

test("buildDailyParity: refreshed driver-week with ZERO Connecteam shifts → manual punch still surfaces as diff", () => {
  // Driver logged no Connecteam shifts for the week but the dispatcher
  // added a manual punch. baselineExists=true (week was refreshed) so
  // every day's CT side is treated as 0 and the manual punch diverges.
  const daily = [
    dt("2026-01-05", 0),
    dt("2026-01-06", 4.5, 0), // dispatcher's manual punch
    dt("2026-01-07", 0),
  ];
  const parity = buildDailyParity(daily, [], true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, false);
  assert.equal(parity[1].connecteamHours, 0);
  assert.equal(parity[2].matches, true);
  assert.deepEqual(summarizeParity(parity), { status: "differ", diffCount: 1 });
});

test("buildDailyParity: AFTER refresh, a no-shift day with zero engine hours is still a match", () => {
  const daily = [dt("2026-01-05", 8), dt("2026-01-06", 0)];
  const snapshot = [{ date: "2026-01-05", hours: "8.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, true);
  assert.equal(parity[1].connecteamHours, 0);
  assert.deepEqual(summarizeParity(parity), { status: "match", diffCount: 0 });
});

test("buildDailyParity: snapshot says 0 but engine says >0 (no customer hours) → real diff", () => {
  const daily = [dt("2026-01-05", 4.25, 0)];
  const snapshot = [{ date: "2026-01-05", hours: "0.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, false);
  assert.equal(parity[0].connecteamHours, 0);
  assert.equal(summarizeParity(parity).status, "differ");
});

test("computeBaselineStaleness: never refreshed → ageHours null, not stale", () => {
  const r = computeBaselineStaleness(null, new Date("2026-05-19T12:00:00Z"), 6);
  assert.equal(r.ageHours, null);
  assert.equal(r.stale, false);
});

test("computeBaselineStaleness: fresh refresh → not stale", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  const refreshed = new Date("2026-05-19T11:00:00Z"); // 1h ago
  const r = computeBaselineStaleness(refreshed, now, 6);
  assert.equal(Math.round(r.ageHours ?? -1), 1);
  assert.equal(r.stale, false);
});

test("computeBaselineStaleness: at/over threshold → stale", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  const r1 = computeBaselineStaleness(
    new Date("2026-05-19T06:00:00Z"),
    now,
    6,
  );
  assert.equal(r1.stale, true);
  const r2 = computeBaselineStaleness(
    new Date("2026-05-18T06:00:00Z"),
    now,
    6,
  );
  assert.equal(r2.stale, true);
  assert.ok((r2.ageHours ?? 0) > 24);
});

test("computeBaselineStaleness: ISO string input is accepted", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  const r = computeBaselineStaleness("2026-05-19T03:00:00Z", now, 6);
  assert.equal(r.stale, true);
  assert.equal(Math.round(r.ageHours ?? -1), 9);
});

test("summarizeParity: every snapshotted day matches → match", () => {
  const daily = [dt("2026-01-05", 8), dt("2026-01-06", 9)];
  const snapshot = [
    { date: "2026-01-05", hours: "8.00" },
    { date: "2026-01-06", hours: "9.00" },
  ];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.deepEqual(summarizeParity(parity), { status: "match", diffCount: 0 });
});
