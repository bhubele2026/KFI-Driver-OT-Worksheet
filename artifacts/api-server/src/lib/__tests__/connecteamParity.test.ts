import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyParity,
  summarizeParity,
} from "../connecteamParity.js";

test("buildDailyParity: matches within 0.005h tolerance, differs outside it", () => {
  const daily = [
    { date: "2026-01-05", totalHours: 8.5 },
    { date: "2026-01-06", totalHours: 8.51 },
    { date: "2026-01-07", totalHours: 9.0 },
  ];
  const snapshot = [
    { date: "2026-01-05", hours: "8.50" },
    { date: "2026-01-06", hours: "8.50" },
    { date: "2026-01-07", hours: "9.00" },
  ];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, false);
  assert.equal(parity[1].connecteamHours, 8.5);
  assert.equal(parity[2].matches, true);
  const sum = summarizeParity(parity);
  assert.equal(sum.status, "differ");
  assert.equal(sum.diffCount, 1);
});

test("buildDailyParity: when no baseline yet, missing snapshot rows are unknown (not a diff)", () => {
  // Driver-week has never been refreshed → baselineExists=false → every day
  // reports `unknown` so the badge stays neutral.
  const daily = [
    { date: "2026-01-05", totalHours: 8.5 },
    { date: "2026-01-06", totalHours: 0 },
  ];
  const parity = buildDailyParity(daily, [], false);
  assert.equal(parity[0].matches, null);
  assert.equal(parity[0].connecteamHours, null);
  assert.equal(parity[1].matches, null);
  assert.deepEqual(summarizeParity(parity), { status: "unknown", diffCount: 0 });
});

test("buildDailyParity: AFTER refresh, a day with no snapshot row is treated as Connecteam=0 (so a manual punch on a no-shift day is a real diff)", () => {
  // This is the regression the reviewer flagged: refresh only writes
  // snapshot rows for days Connecteam reported shifts. If the dispatcher
  // then adds a manual punch on a different day, the parity badge MUST go
  // amber — the dashboard total no longer matches Connecteam.
  const daily = [
    { date: "2026-01-05", totalHours: 8 }, // matches snapshot
    { date: "2026-01-06", totalHours: 4 }, // manual punch on a no-shift day
  ];
  const snapshot = [{ date: "2026-01-05", hours: "8.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, false, "no-shift day with engine hours must be a diff");
  assert.equal(parity[1].connecteamHours, 0);
  assert.deepEqual(summarizeParity(parity), { status: "differ", diffCount: 1 });
});

test("buildDailyParity: refreshed driver-week with ZERO Connecteam shifts → manual punch still surfaces as diff", () => {
  // Reviewer-flagged regression: a driver who logged no Connecteam shifts
  // for the week has a valid (all-zero) baseline once the week has been
  // refreshed. A manual punch added by the dispatcher MUST flip parity to
  // `differ` even though there are no snapshot rows at all for this
  // driver. The route derives `baselineExists` from `week.lastRefreshedAt`,
  // not from snapshot row count, exactly so this case isn't suppressed.
  const daily = [
    { date: "2026-01-05", totalHours: 0 },
    { date: "2026-01-06", totalHours: 4.5 }, // dispatcher's manual punch
    { date: "2026-01-07", totalHours: 0 },
  ];
  const parity = buildDailyParity(daily, [], true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, false);
  assert.equal(parity[1].connecteamHours, 0);
  assert.equal(parity[2].matches, true);
  assert.deepEqual(summarizeParity(parity), { status: "differ", diffCount: 1 });
});

test("buildDailyParity: AFTER refresh, a no-shift day with zero engine hours is still a match", () => {
  const daily = [
    { date: "2026-01-05", totalHours: 8 },
    { date: "2026-01-06", totalHours: 0 }, // no shifts either side
  ];
  const snapshot = [{ date: "2026-01-05", hours: "8.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, true);
  assert.equal(parity[1].matches, true);
  assert.equal(parity[1].connecteamHours, 0);
  assert.deepEqual(summarizeParity(parity), { status: "match", diffCount: 0 });
});

test("buildDailyParity: snapshot says 0 but engine says >0 is a real diff (explicit zero row)", () => {
  const daily = [{ date: "2026-01-05", totalHours: 4.25 }];
  const snapshot = [{ date: "2026-01-05", hours: "0.00" }];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.equal(parity[0].matches, false);
  assert.equal(parity[0].connecteamHours, 0);
  assert.equal(summarizeParity(parity).status, "differ");
});

test("summarizeParity: every snapshotted day matches → match", () => {
  const daily = [
    { date: "2026-01-05", totalHours: 8 },
    { date: "2026-01-06", totalHours: 9 },
  ];
  const snapshot = [
    { date: "2026-01-05", hours: "8.00" },
    { date: "2026-01-06", hours: "9.00" },
  ];
  const parity = buildDailyParity(daily, snapshot, true);
  assert.deepEqual(summarizeParity(parity), { status: "match", diffCount: 0 });
});
