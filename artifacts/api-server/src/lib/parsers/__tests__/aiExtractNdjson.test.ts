/**
 * Unit tests for `parseNdjson` — Task #308's replacement for the old
 * `parseOrSalvage`. The chunked-extract pipeline now asks the model
 * for one JSON object per line tagged with `[R<n>]` and reconciles
 * emitted `_row` IDs against assigned ones, so the parser no longer
 * needs to recover partial state from a single truncated JSON blob;
 * it only needs to skip stray noise and return whatever lines DID
 * parse cleanly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNdjson } from "../aiExtract.js";

test("parseNdjson returns rows from a clean NDJSON stream", () => {
  const raw = [
    `{"_row":1,"driverNameOnDoc":"Jane Doe","date":"2026-05-11","timeIn":"7:00 AM","timeOut":"3:00 PM"}`,
    `{"_row":2,"driverNameOnDoc":"John Roe","date":"2026-05-12","timeIn":"6:30 AM","timeOut":"2:30 PM"}`,
  ].join("\n");
  const out = parseNdjson(raw);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].driverNameOnDoc, "Jane Doe");
  assert.equal(out.nonBlankLines, 2);
  assert.equal(out.parseFailedLines, 0);
  assert.deepEqual([...out.emittedRowIds].sort((a, b) => a - b), [1, 2]);
});

test("parseNdjson records `_row` IDs for `_skip` lines but emits no row", () => {
  // Header rows / subtotal rows: model marks them with `_skip: true`
  // so we don't re-issue them, but they ARE accounted for in
  // `emittedRowIds` so the diff against assigned IDs comes up empty.
  const raw = [
    `{"_row":1,"_skip":true}`,
    `{"_row":2,"driverNameOnDoc":"Jane Doe","date":"2026-05-11","timeIn":"7:00 AM"}`,
  ].join("\n");
  const out = parseNdjson(raw);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].driverNameOnDoc, "Jane Doe");
  assert.deepEqual([...out.emittedRowIds].sort((a, b) => a - b), [1, 2]);
});

test("parseNdjson tolerates blank lines and stray fence markers", () => {
  // Claude occasionally wraps NDJSON in ```ndjson … ``` despite the
  // explicit system instruction. The parser must tolerate both bare
  // ``` markers and blank lines without dropping the body objects.
  const raw = [
    "```ndjson",
    "",
    `{"_row":1,"driverNameOnDoc":"Jane Doe","date":"2026-05-11"}`,
    "",
    `{"_row":2,"driverNameOnDoc":"John Roe","date":"2026-05-12"}`,
    "```",
  ].join("\n");
  const out = parseNdjson(raw);
  assert.equal(out.rows.length, 2);
  assert.equal(out.parseFailedLines, 0);
});

test("parseNdjson tolerates a trailing comma between lines", () => {
  // Mental-array slip: a model that occasionally renders the stream as
  // if it were a JSON array may leave a single trailing comma on each
  // line. Strip one and try again before counting the line as failed.
  const raw = [
    `{"_row":1,"driverNameOnDoc":"Jane Doe","date":"2026-05-11"},`,
    `{"_row":2,"driverNameOnDoc":"John Roe","date":"2026-05-12"}`,
  ].join("\n");
  const out = parseNdjson(raw);
  assert.equal(out.rows.length, 2);
  assert.equal(out.parseFailedLines, 0);
});

test("parseNdjson counts a partial trailing line as a parse failure (no row, no emitted ID)", () => {
  // Classic maxOutputTokens cut-off: the last line is half-written.
  // The earlier complete lines are returned; the partial line shows
  // up as one `parseFailedLines` but does NOT add a `_row` to the
  // emitted set, so the caller's diff against assigned IDs will
  // correctly identify that row as missing and re-issue it.
  const raw = [
    `{"_row":1,"driverNameOnDoc":"Jane Doe","date":"2026-05-11","timeIn":"7:00 AM"}`,
    `{"_row":2,"driverNameOnDoc":"John Roe","date":"2026-05-12","timeIn":"6:30 AM"}`,
    `{"_row":3,"driverNameOnDoc":"Jo`,
  ].join("\n");
  const out = parseNdjson(raw);
  assert.equal(out.rows.length, 2);
  assert.equal(out.nonBlankLines, 3);
  assert.equal(out.parseFailedLines, 1);
  assert.equal(out.emittedRowIds.has(3), false);
});

test("parseNdjson drops lines that lack the required driverNameOnDoc/date keys but still records `_row`", () => {
  // An object that parses but doesn't satisfy the row contract still
  // counts as an emitted `_row` so the caller doesn't re-issue it —
  // re-issuing would just produce the same garbage. Logging /
  // downstream filtering decide whether to surface it.
  const raw = [
    `{"_row":1,"driverNameOnDoc":"Jane Doe","date":"2026-05-11"}`,
    `{"_row":2,"note":"could not extract"}`,
  ].join("\n");
  const out = parseNdjson(raw);
  assert.equal(out.rows.length, 1);
  assert.deepEqual([...out.emittedRowIds].sort((a, b) => a - b), [1, 2]);
});

test("parseNdjson tolerates strings containing braces and embedded quotes", () => {
  // Since each line is independently parsed by JSON.parse, the old
  // brace/quote-state-machine corner cases are gone — but pin the
  // behavior anyway so a future refactor can't reintroduce them.
  const raw =
    `{"_row":1,"driverNameOnDoc":"Smith, J. {nick}","date":"2026-05-11"}\n` +
    `{"_row":2,"driverNameOnDoc":"O\\"Brien \\\\ Co.","date":"2026-05-12"}`;
  const out = parseNdjson(raw);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].driverNameOnDoc, "Smith, J. {nick}");
  assert.equal(out.rows[1].driverNameOnDoc, 'O"Brien \\ Co.');
});

test("parseNdjson returns empty for an empty / whitespace-only response", () => {
  const out = parseNdjson("   \n\n  \n");
  assert.equal(out.rows.length, 0);
  assert.equal(out.nonBlankLines, 0);
  assert.equal(out.parseFailedLines, 0);
  assert.equal(out.emittedRowIds.size, 0);
});
