/** shiftWallClock (frontend util, pure Intl — tested here where node:test lives). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftWallClock, tzShortLabel } from "../../../../kfi-ot/src/lib/tz.js";

test("Eastern → Chicago shifts back one hour", () => {
  assert.equal(
    shiftWallClock("2026-07-28 5:25 AM", "America/New_York", "America/Chicago"),
    "2026-07-28 4:25 AM",
  );
  assert.equal(
    shiftWallClock("2026-07-28 2:57 PM", "America/New_York", "America/Chicago"),
    "2026-07-28 1:57 PM",
  );
});

test("Chicago → Eastern shifts forward, crossing midnight moves the date", () => {
  assert.equal(
    shiftWallClock("2026-07-28 11:30 PM", "America/Chicago", "America/New_York"),
    "2026-07-29 12:30 AM",
  );
});

test("same zone / unparseable input returned unchanged", () => {
  assert.equal(
    shiftWallClock("2026-07-28 5:25 AM", "America/Chicago", "America/Chicago"),
    "2026-07-28 5:25 AM",
  );
  assert.equal(shiftWallClock("garbage", "America/Chicago", "America/New_York"), "garbage");
});

test("DST boundary: Nov 1 2026 2:30 AM ET (post-fallback) maps to 1:30 AM CT", () => {
  assert.equal(
    shiftWallClock("2026-11-01 2:30 AM", "America/New_York", "America/Chicago"),
    "2026-11-01 1:30 AM",
  );
});

test("noon and midnight render as 12:xx with correct AM/PM", () => {
  assert.equal(
    shiftWallClock("2026-07-28 1:00 PM", "America/New_York", "America/Chicago"),
    "2026-07-28 12:00 PM",
  );
  assert.equal(
    shiftWallClock("2026-07-28 1:00 AM", "America/New_York", "America/Chicago"),
    "2026-07-28 12:00 AM",
  );
});

test("tzShortLabel", () => {
  assert.equal(tzShortLabel("America/New_York"), "New York");
  assert.equal(tzShortLabel("America/Chicago"), "Chicago");
});
