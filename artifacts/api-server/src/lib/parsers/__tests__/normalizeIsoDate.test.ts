/**
 * normalizeIsoDate — the bug fix that unblocked the May-10 Adient upload.
 *
 * The downstream week-window filter in `imageSupport.ts` does a *string*
 * compare against `YYYY-MM-DD`. Gemini happily returns dates in any of
 * `M/D/YYYY`, `MM/DD/YY`, `May 12, 2026`, or even ISO strings with a
 * trailing time/zone. Before this normalizer, every one of those shapes
 * silently failed the window check and the upload reported "parsed 0
 * punches" — which is exactly the bug the dispatcher hit. Pin the shapes
 * so a future refactor of this helper can't quietly reintroduce it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIsoDate } from "../aiExtract.js";

test("YYYY-MM-DD is returned unchanged", () => {
  assert.equal(normalizeIsoDate("2026-05-10"), "2026-05-10");
  assert.equal(normalizeIsoDate("2026-5-3"), "2026-05-03");
});

test("YYYY-MM-DD with trailing time/zone is truncated to the date", () => {
  assert.equal(normalizeIsoDate("2026-05-10T07:30:00"), "2026-05-10");
  assert.equal(normalizeIsoDate("2026-05-10T07:30:00-05:00"), "2026-05-10");
  assert.equal(normalizeIsoDate("2026-05-10 07:30"), "2026-05-10");
});

test("US-formatted M/D/YYYY is converted (Gemini's most common drift)", () => {
  assert.equal(normalizeIsoDate("5/10/2026"), "2026-05-10");
  assert.equal(normalizeIsoDate("05/10/2026"), "2026-05-10");
  assert.equal(normalizeIsoDate("12/31/2025"), "2025-12-31");
});

test("Two-digit year is interpreted as 2000s", () => {
  assert.equal(normalizeIsoDate("5/10/26"), "2026-05-10");
  assert.equal(normalizeIsoDate("12/31/25"), "2025-12-31");
});

test("Long-form English dates fall through Date and use UTC slice", () => {
  // UTC-slice is the deliberate choice: parsing "May 12, 2026" with a
  // local-tz `new Date` flips the calendar day in some zones. Pin that
  // we get the date the dispatcher would read off the document.
  assert.equal(normalizeIsoDate("May 12, 2026"), "2026-05-12");
  assert.equal(normalizeIsoDate("2026-05-12T00:00:00.000Z"), "2026-05-12");
});

test("Impossible calendar dates are rejected (not silently coerced)", () => {
  // The regex branches above happily reformat "2/30/2026" to
  // "2026-02-30", which would survive the string-compare window filter
  // downstream and ship a bogus punch. Pin that the calendar-validity
  // pass catches each shape.
  assert.equal(normalizeIsoDate("2/30/2026"), null);
  assert.equal(normalizeIsoDate("2/30/26"), null);
  assert.equal(normalizeIsoDate("2026-02-30"), null);
  assert.equal(normalizeIsoDate("13/01/2026"), null);
  assert.equal(normalizeIsoDate("13/1/26"), null);
  assert.equal(normalizeIsoDate("2026-13-01"), null);
  assert.equal(normalizeIsoDate("0/15/2026"), null);
  assert.equal(normalizeIsoDate("4/31/2026"), null); // April has 30 days
  // Leap-year corners.
  assert.equal(normalizeIsoDate("2/29/2024"), "2024-02-29"); // is a leap year
  assert.equal(normalizeIsoDate("2/29/2025"), null); // is not
});

test("Unparseable / empty / non-string inputs return null", () => {
  assert.equal(normalizeIsoDate(""), null);
  assert.equal(normalizeIsoDate("   "), null);
  assert.equal(normalizeIsoDate("not a date"), null);
  assert.equal(normalizeIsoDate(null), null);
  assert.equal(normalizeIsoDate(undefined), null);
  assert.equal(normalizeIsoDate(20260510), null);
  assert.equal(normalizeIsoDate({}), null);
});
