/**
 * Pins the Claude- and Gemini-tailored prompt shapes after the Task
 * #308 NDJSON cut-over. Both providers now emit one JSON object per
 * line (no `{ "rows": [...] }` wrapper, no surrounding array, no
 * ```json fences), so the prompts share the NDJSON "Output format"
 * section and a worked single-line example. Claude keeps its longer
 * concrete-role framing because Anthropic doesn't enforce a response
 * shape server-side — the framing carries that weight in the prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../aiExtract.js";

const roster = {
  customer: "Adient",
  drivers: [
    { kfiId: "smithjo01", name: "John Smith", badges: ["10472"], aliases: [] },
    { kfiId: "doeja02", name: "Jane Doe", badges: [], aliases: ["J. Doe"] },
  ],
};

test("buildPrompt('claude') frames the role concretely", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.match(p, /payroll-data extractor/i);
  assert.match(p, /logistics dispatcher/i);
  assert.match(p, /Accuracy matters more than coverage/);
});

test("buildPrompt('claude') includes an inline NDJSON example with a worked row (Task #308)", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.ok(p.includes('"driverNameOnDoc"'), "must show driverNameOnDoc key");
  assert.ok(p.includes('"resolvedKfiId"'), "must show resolvedKfiId key");
  assert.ok(p.includes('"_row":1'), "must show the _row tag on the example data line");
  assert.ok(p.includes('"_skip":true'), "must show the _skip example line");
  assert.ok(p.includes('"2026-05-10"'), "sample row must anchor date in the week window");
  assert.ok(/"timeIn":\s*"\d{1,2}:\d{2} (AM|PM)"/.test(p), "must show timeIn format");
  assert.ok(/"hours":\s*\d/.test(p), "must show hours as a decimal");
  // The new contract is per-line objects; the old `{ "rows": [...] }`
  // wrapper must not appear as actual structured output — it may only
  // be referenced in the no-wrapper prohibition.
  assert.ok(
    !/\n\s*\{\s*"rows"\s*:/.test(p),
    "must not show the deprecated rows-wrapper as a structured example",
  );
});

test("buildPrompt('claude') puts the NDJSON Output format section LAST (after the roster)", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  const rosterIdx = p.indexOf("KNOWN DRIVERS");
  const schemaIdx = p.indexOf("Output format");
  assert.ok(rosterIdx > 0, "roster section must be present");
  assert.ok(schemaIdx > rosterIdx, "Output format section must come after the roster");
});

test("buildPrompt('claude') explicitly forbids markdown fences, arrays, prose (Task #308)", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  // Forbids fences in two places (Rules block + Output format block).
  assert.match(p, /No ```json fences/);
  assert.match(p, /No prose before or after/);
  // NDJSON-specific: no surrounding array, no rows-wrapper.
  assert.match(p, /No surrounding `\[\.\.\.\]` array/);
  assert.match(p, /No outer `\{ "rows": \[\.\.\.\]/);
});

test("buildPrompt('claude') warns omit-don't-null and never-invent", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.match(p, /omitted \(not set to null\)/);
  assert.match(p, /Do not invent rows/);
  assert.match(p, /partial extract is fine; fabrication is not/);
});

test("buildPrompt('claude') instructs to echo the [R<n>] tag on every output line (Task #308)", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.match(p, /\[R<n>\]/);
  assert.match(p, /"_row"/);
  assert.match(p, /"_skip":true/);
});

test("buildPrompt() default (Gemini) is the NDJSON shape too (Task #308)", () => {
  // Gemini no longer uses `responseSchema`; both providers share the
  // NDJSON contract so the test just pins the per-line shape.
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster);
  assert.match(p, /^You are extracting timecard punches/m);
  assert.ok(!p.includes("payroll-data extractor"), "must not pick up Claude framing");
  assert.match(p, /NDJSON/);
  assert.ok(p.includes('"_row":1'), "Gemini prompt must show the _row tag example");
  assert.ok(
    !/\n\s*\{\s*"rows"\s*:/.test(p),
    "Gemini prompt must not show the deprecated rows-wrapper as a structured example",
  );
});

test("buildPrompt('claude') caps the roster at 200 drivers with an omitted-count note", () => {
  const big = {
    customer: "Adient",
    drivers: Array.from({ length: 250 }, (_, i) => ({
      kfiId: `id${i}`,
      name: `Driver ${i}`,
      badges: [],
      aliases: [],
    })),
  };
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", big, "claude");
  assert.match(p, /50 more drivers omitted from this prompt/);
});
