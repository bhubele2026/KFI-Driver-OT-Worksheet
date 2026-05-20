/**
 * Unit tests for `parseOrSalvage` — the fallback that recovers partial
 * rows from a Gemini response truncated by `maxOutputTokens`. The
 * production failure mode this guards against is the upload returning
 * "model did not return valid JSON" and discarding ~150 already-extracted
 * punches just because the last row was incomplete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrSalvage } from "../aiExtract.js";

test("parseOrSalvage strips markdown code fences before parsing (Claude #293 follow-up)", () => {
  // Claude Sonnet intermittently wraps structured-output responses in
  // ```json … ``` despite the explicit "no markdown fences" system
  // instruction. Verified on Adient Daily punches PP 05.10.2026
  // upload during the first live Claude run.
  const inner = JSON.stringify({
    rows: [
      { driverNameOnDoc: "Jane Doe", date: "2026-05-11", timeIn: "7:00 AM" },
      { driverNameOnDoc: "John Roe", date: "2026-05-12", timeIn: "6:30 AM" },
    ],
  });
  const raw = "```json\n" + inner + "\n```";
  const out = parseOrSalvage(raw, "Adient", "test.xlsx");
  assert.equal(out.truncated, false);
  assert.equal(out.rows?.length, 2);
  assert.equal(out.rows?.[0].driverNameOnDoc, "Jane Doe");
});

test("parseOrSalvage strips a bare ``` fence (no language tag) too", () => {
  const inner = JSON.stringify({ rows: [{ driverNameOnDoc: "Jane Doe" }] });
  const raw = "```\n" + inner + "\n```";
  const out = parseOrSalvage(raw, "Adient", "test.xlsx");
  assert.equal(out.rows?.length, 1);
});

test("parseOrSalvage salvages a fenced + mid-row-truncated Claude response", () => {
  // Real-world Adient failure mode: fence opener present, no closer
  // (because the response was cut off mid-row by maxOutputTokens).
  const raw =
    "```json\n" +
    '{"rows":[' +
    '{"driverNameOnDoc":"Jane Doe","date":"2026-05-11","timeIn":"7:00 AM"},' +
    '{"driverNameOnDoc":"John Roe","date":"2026-05-12","timeIn":"6:30 AM"},' +
    '{"driverNameOnDoc":"Jo';
  const out = parseOrSalvage(raw, "Adient", "test.xlsx", { warn: () => {} });
  assert.equal(out.truncated, true);
  assert.equal(out.rows?.length, 2);
});

test("parseOrSalvage returns parsed JSON unchanged when well-formed", () => {
  const raw = JSON.stringify({
    rows: [
      { driverNameOnDoc: "Jane Doe", date: "2026-05-11" },
      { driverNameOnDoc: "John Roe", date: "2026-05-12" },
    ],
  });
  const out = parseOrSalvage(raw, "Adient", "test.xlsx");
  assert.equal(out.rows?.length, 2);
});

test("parseOrSalvage salvages a response truncated mid-row", () => {
  // Two complete rows, then truncated mid-string in the third row.
  const raw =
    '{"rows":[' +
    '{"driverNameOnDoc":"Jane Doe","date":"2026-05-11","timeIn":"7:00 AM"},' +
    '{"driverNameOnDoc":"John Roe","date":"2026-05-12","timeIn":"6:30 AM"},' +
    '{"driverNameOnDoc":"Jo';
  const out = parseOrSalvage(raw, "Adient", "test.xlsx");
  assert.equal(out.rows?.length, 2);
  assert.equal(out.rows?.[0].driverNameOnDoc, "Jane Doe");
  assert.equal(out.rows?.[1].driverNameOnDoc, "John Roe");
});

test("parseOrSalvage handles braces inside string values", () => {
  // A `}` inside a quoted string must not be counted as a closing brace.
  const raw =
    '{"rows":[' +
    '{"driverNameOnDoc":"Smith, J. {nick}","date":"2026-05-11","timeIn":"7:00 AM"},' +
    '{"driverNameOnDoc":"trun';
  const out = parseOrSalvage(raw, "Adient", "test.xlsx");
  assert.equal(out.rows?.length, 1);
  assert.equal(out.rows?.[0].driverNameOnDoc, "Smith, J. {nick}");
});

test("parseOrSalvage throws when no row is complete", () => {
  const raw = '{"rows":[{"driverNameOnDoc":"trun';
  assert.throws(
    () => parseOrSalvage(raw, "Adient", "test.xlsx"),
    /truncated|salvage/i,
  );
});

test("parseOrSalvage handles escaped quotes and backslashes in strings", () => {
  // Truncation lands after several escaped quotes and a trailing
  // backslash in a string value — must not desync the string-state
  // machine.
  const raw =
    '{"rows":[' +
    '{"driverNameOnDoc":"O\\"Brien \\\\ Co.","date":"2026-05-11","timeIn":"7:00 AM"},' +
    '{"driverNameOnDoc":"path C:\\\\Users\\\\","date":"2026-05-12","timeIn":"6:00 AM"},' +
    '{"driverNameOnDoc":"trun\\"';
  const out = parseOrSalvage(raw, "Adient", "test.xlsx");
  assert.equal(out.rows?.length, 2);
  assert.equal(out.rows?.[0].driverNameOnDoc, 'O"Brien \\ Co.');
  assert.equal(out.rows?.[1].driverNameOnDoc, "path C:\\Users\\");
});

test("parseOrSalvage throws when there is no rows array at all", () => {
  const raw = "garbage with no brackets";
  assert.throws(
    () => parseOrSalvage(raw, "Adient", "test.xlsx"),
    /salvaged|rows array/i,
  );
});
