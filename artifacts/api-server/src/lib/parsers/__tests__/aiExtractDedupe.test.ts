/**
 * Server-side dedupe pass on AI-extracted rows (Task #261).
 *
 * The AI prompt now asks Gemini for one output row per non-empty data
 * row — the prior "one row per shift per driver per date" wording made
 * Gemini drop every Pay-Category-split line on Trienda/Kronos exports
 * (only 14 rows came back from a 762-row, 330-shift file). To pay for
 * that change without inflating the dispatcher's preview, this dedupe
 * collapses pay-category-split duplicates AFTER extraction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAiRows, type AiExtractedRow } from "../aiExtract.js";

test("dedupeAiRows collapses pay-category-split duplicates by (name+badge, date, in, out) — first wins", () => {
  const rows: AiExtractedRow[] = [
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8,
    },
    // Same shift, same clocks — Gemini emitted the "OT 1.5" pay-bucket line.
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 0.5,
    },
    // Same shift, same clocks — "SHIFT PREM-Day" line.
    {
      driverNameOnDoc: "Bailey, R.",
      badgeOrId: "TELD9001",
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8.5,
    },
    // Genuinely different shift on the same day — must survive.
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
  assert.equal(out.length, 2, "three pay-bucket lines collapse to one");
  // First-wins on clock-time duplicates → hours from the original row.
  assert.equal(out[0].hours, 8);
  assert.equal(out[0].timeIn, "6:00 AM");
  assert.equal(out[0].timeOut, "2:30 PM");
  // Second shift untouched.
  assert.equal(out[1].timeIn, "4:00 PM");
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
  assert.equal(dedupeAiRows(rows).length, 1);
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
