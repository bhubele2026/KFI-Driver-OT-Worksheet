import { test } from "node:test";
import assert from "node:assert/strict";

import type { Driver, Punch } from "@workspace/db/schema";
import {
  buildTimesheets,
  renderTimesheetsHtml,
  UNASSIGNED_CUSTOMER,
} from "../timesheets.js";
import { computeDriverTotals } from "../hoursEngine.js";

const WEEK_START = "2026-04-27"; // Monday
const WEEK_END = "2026-05-03"; // Sunday

let punchId = 1;
function p(over: Partial<Punch> & { kfiId: string; date: string }): Punch {
  return {
    id: punchId++,
    weekStart: WEEK_START,
    customer: null,
    source: "Driver",
    clockIn: `${over.date} 8:00 AM`,
    clockOut: `${over.date} 4:00 PM`,
    hours: "8.000",
    payType: null,
    dispTz: "America/Chicago",
    isManual: false,
    edited: false,
    ctExternalKey: null,
    fileOrigin: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-04-28T12:00:00Z"),
    updatedAt: new Date("2026-04-28T12:00:00Z"),
    ...over,
  } as Punch;
}

function shift(
  kfiId: string,
  date: string,
  startHour: number,
  hours: number,
  source: "Driver" | "Customer" = "Driver",
  customer: string | null = null,
): Punch {
  const sh = (h: number): string => {
    const hr12 = ((h + 11) % 12) + 1;
    const ampm = h < 12 || h === 24 ? "AM" : "PM";
    return `${date} ${hr12}:00 ${ampm}`;
  };
  return p({
    kfiId,
    date,
    clockIn: sh(startHour),
    clockOut: sh(startHour + hours),
    hours: hours.toFixed(3),
    source,
    customer,
  });
}

function driver(kfiId: string, name: string, customer: string): Driver {
  return {
    kfiId,
    name,
    customer,
    ctUserId: null,
    isDriver: true,
    isArchived: false,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

test("buildTimesheets orders drivers like the sidebar (KNOWN_CUSTOMERS, then extras alpha, then roster cleanup)", () => {
  const drivers: Driver[] = [
    driver("1001", "Alice Adient", "Adient"),
    driver("1002", "Greg Greystone", "Greystone"),
    driver("1003", "Aaron Acme", "Acme Manufacturing"), // unknown extra (a-)
    driver("1004", "Wendy Widgets", "Widgets Inc"), // unknown extra (w-)
    driver("1005", "Owen Orphan", "Unknown"), // → Needs roster cleanup
  ];
  const punches: Punch[] = [
    shift("1001", "2026-04-27", 8, 8),
    shift("1002", "2026-04-27", 8, 8),
    shift("1003", "2026-04-27", 8, 8),
    shift("1004", "2026-04-27", 8, 8),
    shift("1005", "2026-04-27", 8, 8),
  ];
  const sheets = buildTimesheets(punches, drivers);
  assert.deepEqual(
    sheets.map((s) => s.kfiId),
    ["1001", "1002", "1003", "1004", "1005"],
    "Adient → Greystone → Acme (alpha) → Widgets (alpha) → roster cleanup",
  );
  assert.equal(sheets[4].customerLabel, UNASSIGNED_CUSTOMER);
  // Within a customer, drivers sort by name. Add a sibling and verify.
  const drivers2: Driver[] = [
    ...drivers,
    driver("1006", "Aaron Adient", "Adient"),
  ];
  const punches2 = [...punches, shift("1006", "2026-04-27", 8, 8)];
  const sheets2 = buildTimesheets(punches2, drivers2);
  const adientOrder = sheets2.filter((s) => s.customer === "Adient").map(
    (s) => s.name,
  );
  assert.deepEqual(adientOrder, ["Aaron Adient", "Alice Adient"]);
});

test("buildTimesheets per-driver totals match computeDriverTotals", () => {
  const drivers: Driver[] = [driver("2001", "Sam Splitter", "Adient")];
  // 4 days x 9 hours = 36 RT, then a 9-hour shift on day 5 splits 4 RT + 5 OT
  // (crossing the 40h boundary mid-shift).
  const punches: Punch[] = [
    shift("2001", "2026-04-27", 8, 9),
    shift("2001", "2026-04-28", 8, 9),
    shift("2001", "2026-04-29", 8, 9),
    shift("2001", "2026-04-30", 8, 9),
    shift("2001", "2026-05-01", 8, 9),
  ];
  const sheets = buildTimesheets(punches, drivers);
  assert.equal(sheets.length, 1);
  const totals = sheets[0].totals;
  const expected = computeDriverTotals(punches);
  assert.deepEqual(totals, expected);
  assert.equal(totals.totalHours, 45);
  assert.equal(totals.regularHours, 40);
  assert.equal(totals.overtimeHours, 5);

  // Per-row running totals reflect the chronological add-up, and the
  // boundary-crossing shift has a non-zero OT portion.
  const rows = sheets[0].rows;
  assert.deepEqual(rows.map((r) => r.after), [9, 18, 27, 36, 45]);
  assert.equal(rows[4].rtPortion, 4);
  assert.equal(rows[4].otPortion, 5);
  // Earlier shifts are entirely RT.
  for (let i = 0; i < 4; i++) {
    assert.equal(rows[i].otPortion, 0);
  }
});

test("renderTimesheetsHtml emits page-break markers between drivers and OT-row highlighting", () => {
  const drivers: Driver[] = [
    driver("3001", "Alice Adient", "Adient"),
    driver("3002", "Sam Splitter", "Adient"),
    driver("3003", "Greg Greystone", "Greystone"),
  ];
  const punches: Punch[] = [
    shift("3001", "2026-04-27", 8, 8),
    // 3002 crosses 40h threshold: 4x9h then a final 9h shift.
    shift("3002", "2026-04-27", 8, 9),
    shift("3002", "2026-04-28", 8, 9),
    shift("3002", "2026-04-29", 8, 9),
    shift("3002", "2026-04-30", 8, 9),
    shift("3002", "2026-05-01", 8, 9),
    shift("3003", "2026-04-27", 8, 8),
  ];
  const sheets = buildTimesheets(punches, drivers);
  assert.deepEqual(
    sheets.map((s) => s.kfiId),
    ["3001", "3002", "3003"],
  );
  const html = renderTimesheetsHtml({
    weekStart: WEEK_START,
    endDate: WEEK_END,
    sheets,
    lastRefreshedAt: null,
  });
  // First section has no page-break, every subsequent section does.
  const sectionCount = (html.match(/<section class="sheet/g) ?? []).length;
  const pageBreakCount = (html.match(/<section class="sheet page-break"/g) ?? [])
    .length;
  assert.equal(sectionCount, 3);
  assert.equal(pageBreakCount, 2, "non-first sections carry a page-break marker");

  // Sam Splitter's OT-portion shift renders with the .ot row class and the
  // running cell uses the .ot-num style.
  assert.match(html, /<tr class="ot">/);
  assert.match(html, /class="num ot-num"/);

  // Driver order in the document mirrors the sheets array.
  const headlineOrder = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(headlineOrder, [
    "Alice Adient",
    "Sam Splitter",
    "Greg Greystone",
  ]);
});

test("renderTimesheetsHtml labels the roster-cleanup bucket and survives a missing driver row", () => {
  const drivers: Driver[] = [driver("4001", "Alice Adient", "Adient")];
  const punches: Punch[] = [
    shift("4001", "2026-04-27", 8, 8),
    // No driver row for 4002 → falls back to "Driver 4002" + customer from punch
    shift("4002", "2026-04-27", 8, 8, "Driver", "Unknown"),
  ];
  const sheets = buildTimesheets(punches, drivers);
  const orphan = sheets.find((s) => s.kfiId === "4002");
  assert.ok(orphan);
  assert.equal(orphan!.name, "Driver 4002");
  assert.equal(orphan!.customerLabel, UNASSIGNED_CUSTOMER);
  // Roster-cleanup driver always sorts last.
  assert.equal(sheets[sheets.length - 1].kfiId, "4002");

  const html = renderTimesheetsHtml({
    weekStart: WEEK_START,
    endDate: WEEK_END,
    sheets,
    lastRefreshedAt: null,
  });
  assert.match(html, new RegExp(`Customer:\\s*<strong>${UNASSIGNED_CUSTOMER}</strong>`));
});
