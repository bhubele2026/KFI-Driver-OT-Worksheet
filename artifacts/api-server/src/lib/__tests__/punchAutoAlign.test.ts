/** decideDayShift — whole-day ±1h driver-punch auto-alignment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideDayShift,
  shiftWallHours,
  wallClockToMs,
  type AlignPunch,
} from "../punchAutoAlign.js";

let nextId = 1;
const p = (
  source: "Driver" | "Customer",
  clockIn: string,
  clockOut: string,
  dispTz: string,
  extra: Partial<AlignPunch> = {},
): AlignPunch => ({
  id: nextId++,
  source,
  clockIn,
  clockOut,
  dispTz,
  isManual: false,
  edited: null,
  ...extra,
});

const CT = "America/Chicago";
const ET = "America/New_York";

test("Davidson Monday: whole day shifts -1h (drives an hour fast vs Eastern shift)", () => {
  const day = [
    p("Driver", "2026-07-27 5:15 AM", "2026-07-27 5:22 AM", CT),
    p("Customer", "2026-07-27 5:23 AM", "2026-07-27 2:34 PM", ET),
    p("Driver", "2026-07-27 2:37 PM", "2026-07-27 3:02 PM", CT),
  ];
  assert.equal(decideDayShift(day, CT), -1);
});

test("Davidson Tuesday (a correct day): untouched", () => {
  const day = [
    p("Driver", "2026-07-28 4:09 AM", "2026-07-28 4:24 AM", CT),
    p("Customer", "2026-07-28 5:25 AM", "2026-07-28 2:57 PM", ET),
    p("Driver", "2026-07-28 1:59 PM", "2026-07-28 2:32 PM", CT),
  ];
  assert.equal(decideDayShift(day, CT), 0);
});

test("driver an hour SLOW shifts +1h", () => {
  const day = [
    // True chain would be 4:15-4:22 → shift 4:23; drive recorded 3:15-3:22.
    p("Driver", "2026-07-27 3:15 AM", "2026-07-27 3:22 AM", CT),
    p("Customer", "2026-07-27 5:23 AM", "2026-07-27 2:34 PM", ET),
    p("Driver", "2026-07-27 12:37 PM", "2026-07-27 1:02 PM", CT),
  ];
  assert.equal(decideDayShift(day, CT), 1);
});

test("genuine mid-shift van move: overlap that no ±1h makes clean → untouched", () => {
  const day = [
    p("Driver", "2026-07-27 9:00 AM", "2026-07-27 9:20 AM", CT),
    p("Customer", "2026-07-27 4:23 AM", "2026-07-27 1:34 PM", CT),
  ];
  assert.equal(decideDayShift(day, CT), 0);
});

test("manual and hand-edited driver punches are never candidates", () => {
  const day = [
    p("Driver", "2026-07-27 5:15 AM", "2026-07-27 5:22 AM", CT, { isManual: true }),
    p("Customer", "2026-07-27 5:23 AM", "2026-07-27 2:34 PM", ET),
  ];
  assert.equal(decideDayShift(day, CT), 0);
  const day2 = [
    p("Driver", "2026-07-27 5:15 AM", "2026-07-27 5:22 AM", CT, { edited: true }),
    p("Customer", "2026-07-27 5:23 AM", "2026-07-27 2:34 PM", ET),
  ];
  assert.equal(decideDayShift(day2, CT), 0);
});

test("driver-only or customer-only days: untouched", () => {
  assert.equal(
    decideDayShift([p("Driver", "2026-07-27 5:15 AM", "2026-07-27 5:22 AM", CT)], CT),
    0,
  );
  assert.equal(
    decideDayShift([p("Customer", "2026-07-27 5:23 AM", "2026-07-27 2:34 PM", ET)], CT),
    0,
  );
});

test("shiftWallHours: pure wall-clock math, midnight crossing changes the date", () => {
  assert.equal(shiftWallHours("2026-07-27 5:15 AM", -1), "2026-07-27 4:15 AM");
  assert.equal(shiftWallHours("2026-07-27 12:30 AM", -1), "2026-07-26 11:30 PM");
  assert.equal(shiftWallHours("2026-07-27 11:30 PM", 1), "2026-07-28 12:30 AM");
});

test("wallClockToMs: Chicago and New York differ by exactly one hour in July", () => {
  const ct = wallClockToMs("2026-07-27 5:15 AM", CT)!;
  const et = wallClockToMs("2026-07-27 5:15 AM", ET)!;
  assert.equal(ct - et, 3_600_000);
});
