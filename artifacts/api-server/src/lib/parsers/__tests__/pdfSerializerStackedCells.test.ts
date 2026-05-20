/**
 * Task #375 — verify the pdfjs text serializer pairs stacked-cell
 * date/time pairs (DeLallo daily-punches layout) into one logical
 * line, and verifies that single-line layouts (Adient/IWG-style) are
 * unaffected byte-for-byte.
 *
 * Hermetic: no pdfjs, no DB, no model. Builds synthetic pdfjs
 * `getTextContent` items by hand and runs them through the exported
 * `serializePdfTextItems` helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializePdfTextItems } from "../aiExtract.js";

type Item = { str: string; transform: number[] };

function item(x: number, y: number, s: string): Item {
  // pdfjs transform matrix shape — only [4] (x) and [5] (y) matter
  // to the serializer; the other slots are a no-op identity for the
  // serializer's purposes.
  return { str: s, transform: [1, 0, 0, 1, x, y] };
}

test("stacked-cell row: date on top line, time on the line below, pairs inside each cell", () => {
  // Visual layout (DeLallo daily-punch grid simplified to 3 days):
  //   05/10    05/11    05/12
  //   6:05AM   5:54AM   6:01AM
  // x positions per column are tight (within tolerance); y gap
  // between the two rows is small (one line-height).
  const items: Item[] = [
    // upper band (dates) — y = 500
    item(100, 500, "05/10"),
    item(200, 500, "05/11"),
    item(300, 500, "05/12"),
    // lower band (times) — y = 490 (gap of 10 < STACK_MAX_GAP=14)
    item(100, 490, "6:05AM"),
    item(201, 490, "5:54AM"), // 1px drift — still within STACKED_X_TOL
    item(299, 490, "6:01AM"),
  ];
  const out = serializePdfTextItems(items);
  // One logical line, each cell paired with its date.
  assert.equal(out, "05/10 6:05AM 05/11 5:54AM 05/12 6:01AM");
});

test("flat single-baseline row (Adient/IWG-style): byte-for-byte identical to legacy serializer", () => {
  // A typical "header row + one data row" layout where date and time
  // share a baseline. The legacy serializer joined each y-band with a
  // single space; the new serializer must do exactly the same.
  const items: Item[] = [
    // header y = 600
    item(50, 600, "Date"),
    item(150, 600, "TimeIn"),
    item(250, 600, "TimeOut"),
    item(350, 600, "Driver"),
    // data y = 580 (gap of 20 — beyond STACK_MAX_GAP so NOT merged)
    item(50, 580, "05/10"),
    item(150, 580, "6:05AM"),
    item(250, 580, "2:30PM"),
    item(350, 580, "SMITH"),
  ];
  const out = serializePdfTextItems(items);
  assert.equal(out, "Date TimeIn TimeOut Driver\n05/10 6:05AM 2:30PM SMITH");
});

test("close-but-misaligned bands stay separate (no false merge for adjacent independent rows)", () => {
  // Two y-bands that are close vertically but represent independent
  // rows — their x positions don't line up. Must NOT be merged.
  const items: Item[] = [
    // row 1 y = 500
    item(100, 500, "JONES"),
    item(220, 500, "DELIVERY"),
    item(360, 500, "8.5"),
    // row 2 y = 488 (gap of 12 — within STACK_MAX_GAP) but x's
    // don't column-align with row 1
    item(105, 488, "SMITH"),
    item(245, 488, "PICKUP"),
    item(380, 488, "9.25"),
  ];
  const out = serializePdfTextItems(items);
  // Two separate lines, current behaviour preserved.
  assert.equal(out, "JONES DELIVERY 8.5\nSMITH PICKUP 9.25");
});

test("partial subset (3 of 4 lower items column-align with upper) still merges", () => {
  // Common real-world case: one trailing total cell on the lower
  // band that doesn't have a date above it. As long as the bulk
  // (>= 75%) aligns, we still pair the stacked cells; the orphan
  // tail is appended.
  const items: Item[] = [
    // upper: 4 dates
    item(100, 500, "05/10"),
    item(200, 500, "05/11"),
    item(300, 500, "05/12"),
    item(400, 500, "05/13"),
    // lower: 4 times — last one drifts way off (different column)
    item(100, 489, "6:00AM"),
    item(200, 489, "6:10AM"),
    item(300, 489, "6:20AM"),
    item(480, 489, "TOTAL"),
  ];
  const out = serializePdfTextItems(items);
  // First three columns paired; "TOTAL" appended as orphan.
  assert.equal(
    out,
    "05/10 6:00AM 05/11 6:10AM 05/12 6:20AM 05/13 TOTAL",
  );
});

test("single-item lower band never triggers merge (too small to confirm a column pattern)", () => {
  // A two-item upper followed by a one-item "trailer" must stay as
  // two separate lines — one isolated item below doesn't prove cell
  // stacking.
  const items: Item[] = [
    item(100, 500, "05/10"),
    item(200, 500, "05/11"),
    item(100, 490, "page 1"),
  ];
  const out = serializePdfTextItems(items);
  assert.equal(out, "05/10 05/11\npage 1");
});

test("semantic gate: aligned adjacent rows that aren't date+time stay separate", () => {
  // The IWG false-positive case the architect caught: two adjacent
  // form-field rows whose x positions happen to column-align and
  // whose y gap is small, but the content is NOT date-over-time —
  // it's "Status: Active" stacked above "Status Date: 4/20/26".
  // Must stay as two separate lines because the upper band isn't
  // dominantly date-shaped.
  const items: Item[] = [
    // row 1 y = 596 ("Status:" "Active" "Status Date:" "4/20/26")
    item(38, 596, "Status:"),
    item(97, 596, "Active"),
    item(217, 596, "Status Date:"),
    item(277, 596, "4/20/26"),
    // row 2 y = 583 (gap = 13, within STACK_MAX_GAP) —
    // same x columns, but content is "Primary Job:" etc.
    item(38, 583, "Primary Job:"),
    item(97, 583, "Driver"),
    item(217, 583, "Start Date:"),
    item(277, 583, "4/26/26"),
  ];
  const out = serializePdfTextItems(items);
  assert.equal(
    out,
    "Status: Active Status Date: 4/20/26\nPrimary Job: Driver Start Date: 4/26/26",
  );
});

test("semantic gate: dates over non-times also stay separate", () => {
  // Two date-shaped lines stacked — must NOT merge because the
  // lower band isn't clock-time-shaped.
  const items: Item[] = [
    item(100, 500, "05/10"),
    item(200, 500, "05/11"),
    item(300, 500, "05/12"),
    item(100, 489, "05/13"),
    item(200, 489, "05/14"),
    item(300, 489, "05/15"),
  ];
  const out = serializePdfTextItems(items);
  assert.equal(out, "05/10 05/11 05/12\n05/13 05/14 05/15");
});
