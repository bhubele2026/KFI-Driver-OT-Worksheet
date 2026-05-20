/**
 * Server-side dedupe pass on AI-extracted rows.
 *
 * The AI prompt asks Gemini for one output row per non-empty data row
 * — the prior "one row per shift per driver per date" wording made
 * Gemini drop every Pay-Category-split line on Trienda/Kronos exports
 * (only 14 rows came back from a 762-row, 330-shift file).
 *
 * Task #261 introduced the dedupe pass. Task #376 then changed the
 * clock-times-collision branch from "first wins" to "sum when both
 * carry hours" so Burnett's Reg+OT split rows (3.33 RT + 8.77 OT for
 * the same shift) total to the full 12.10h instead of silently
 * dropping the OT bucket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAiRows, type AiExtractedRow } from "../aiExtract.js";

test("dedupeAiRows sums Reg+OT pay-category split rows that share clock times (Task #376)", () => {
  // Mirrors the Burnett Felix 5/14 shape from the bug report: same
  // clocks, two rows because the customer file splits Reg and OT into
  // separate pay-bucket lines. Must sum so the dashboard shows the
  // full 12.10h shift instead of just the first bucket's 3.33h.
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Felix, J.",
      badgeOrId: "BURN42",
      date: "2026-05-14",
      timeIn: "5:00 AM",
      timeOut: "5:06 PM",
      hours: 3.33,
    },
    {
      driverNameOnDoc: "Felix, J.",
      badgeOrId: "BURN42",
      date: "2026-05-14",
      timeIn: "5:00 AM",
      timeOut: "5:06 PM",
      hours: 8.77,
    },
  ];
  const out = dedupeAiRows(rows);
  assert.equal(out.length, 1, "Reg+OT bucket lines collapse to one shift");
  assert.ok(
    out[0].hours !== undefined && Math.abs((out[0].hours as number) - 12.1) < 0.001,
    `expected summed 12.10, got ${out[0].hours}`,
  );
  assert.equal(out[0].timeIn, "5:00 AM");
  assert.equal(out[0].timeOut, "5:06 PM");
});

test("dedupeAiRows collapses without doubling when only one side has hours (label-only duplicate)", () => {
  // "Same shift emitted twice with no pay split" — the canonical case
  // dedupe was originally guarding against. Only one row carries
  // hours, so we keep it without doubling.
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8,
    },
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      // no hours — a chunk-overlap re-emission or label-only repeat
    },
  ];
  const out = dedupeAiRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].hours, 8, "hours preserved, not doubled");
});

test("dedupeAiRows sanity-check prefers the larger value when stated hours disagree with clock-time span", () => {
  // Single AI row, no duplicate at all — but the AI's stated hours
  // (4) drastically under-reports the actual 8-hour clock span. The
  // backstop should warn and prefer the larger value so payroll
  // doesn't silently truncate.
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log = {
    warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }),
  };
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Garcia, M.",
      badgeOrId: "ACME77",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:00 PM",
      hours: 4, // wrong — span is 8h
    },
  ];
  const out = dedupeAiRows(rows, { log, customer: "Acme", fileName: "test.xlsx" });
  assert.equal(out.length, 1);
  assert.equal(out[0].hours, 8, "larger (computed span) wins over the AI's stated value");
  assert.equal(warnings.length, 1, "one warning logged");
  assert.match(warnings[0].msg, /disagree/i);
  assert.equal(warnings[0].obj.customer, "Acme");
  assert.equal(warnings[0].obj.driver, "Garcia, M.");
  assert.equal(warnings[0].obj.statedHours, 4);
  assert.equal(warnings[0].obj.computedHours, 8);
});

test("dedupeAiRows sanity-check stays quiet when stated hours match clock-time span within tolerance", () => {
  // The Burnett summed result (12.10) should match the clock-time
  // span (5:00 AM → 5:06 PM = 12.10h) — no warning expected.
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log = {
    warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }),
  };
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Felix, J.",
      badgeOrId: "BURN42",
      date: "2026-05-14",
      timeIn: "5:00 AM",
      timeOut: "5:06 PM",
      hours: 3.33,
    },
    {
      driverNameOnDoc: "Felix, J.",
      badgeOrId: "BURN42",
      date: "2026-05-14",
      timeIn: "5:00 AM",
      timeOut: "5:06 PM",
      hours: 8.77,
    },
  ];
  const out = dedupeAiRows(rows, { log });
  assert.equal(out.length, 1);
  assert.ok(Math.abs((out[0].hours as number) - 12.1) < 0.001);
  assert.equal(warnings.length, 0, "no warning when summed hours match span");
});

test("dedupeAiRows is case-insensitive on name + badge", () => {
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "BAILEY, R.",
      badgeOrId: "teld9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
    },
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
    },
  ];
  assert.equal(dedupeAiRows(rows).length, 1);
});

test("dedupeAiRows sums hours when ALL duplicates lack clock times (hours-only export)", () => {
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Jones, K.",
      badgeOrId: "TELD9002",
      date: "2026-05-12",
      timeIn: null,
      timeOut: null,
      hours: 32, // Reg
    },
    {
      driverNameOnDoc: "Jones, K.",
      badgeOrId: "TELD9002",
      date: "2026-05-12",
      timeIn: null,
      timeOut: null,
      hours: 8, // OT
    },
  ];
  const out = dedupeAiRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].hours, 40, "Reg + OT summed for hours-only duplicates");
});

test("dedupeAiRows keeps rows on different dates as separate even with same driver + clocks", () => {
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
    },
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-13",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
    },
  ];
  assert.equal(dedupeAiRows(rows).length, 2);
});

test("dedupeAiRows keeps a genuinely different shift on the same day as a separate row", () => {
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8,
    },
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "4:00 PM",
      timeOut: "8:00 PM",
      hours: 4,
    },
  ];
  const out = dedupeAiRows(rows);
  assert.equal(out.length, 2, "different clocks → different shifts");
});

test("dedupeAiRows normalizes date + time formatting variance across pay-category splits", () => {
  // Same shift, but Gemini emitted date as "5/12/2026" on one line and
  // "2026-05-12" on the OT line, and time as "06:00 AM" vs "6:00 AM".
  // Both must still collapse — otherwise the strict-string key misses
  // the duplicate and inflates the dispatcher's preview.
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "5/12/2026",
      timeIn: "06:00 AM",
      timeOut: "02:30 PM",
      hours: 8,
    },
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 0.5,
    },
  ];
  const out = dedupeAiRows(rows);
  assert.equal(out.length, 1);
  // Both rows had hours → summed (Task #376 behavior).
  assert.equal(out[0].hours, 8.5);
});

test("dedupeAiRows preserves rows whose only difference is presence/absence of clock times", () => {
  // Edge case: one line has clocks, another for the same date has only hours.
  // These are NOT the same source row — keep both. The clocks-present row
  // hits the with-times bucket; the hours-only row hits a different key
  // (empty timeIn/timeOut), so both survive.
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8,
    },
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: null,
      timeOut: null,
      hours: 0.5,
    },
  ];
  assert.equal(dedupeAiRows(rows).length, 2);
});
