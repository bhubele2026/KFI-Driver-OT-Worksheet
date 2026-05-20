/**
 * Pins the Claude-tailored prompt shape (Task #293 follow-up). Claude
 * Sonnet ignores Anthropic's lack of a `responseSchema` parameter and
 * follows whatever the prompt tells it, so the tuned prompt must:
 *  - frame the role concretely in payroll terms,
 *  - include the JSON schema as an inline example block,
 *  - put the schema example LAST (right before the document the chunker
 *    appends), so it's the freshest context Claude sees, and
 *  - call out "no ```json fences, no prose" explicitly because that was
 *    the first live-fire failure mode after the cut-over.
 *
 * The Gemini prompt must stay identical to its pre-tuning shape because
 * Gemini's `responseSchema` enforcement already handles output format
 * and adding the inline example actually regresses its behaviour.
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

test("buildPrompt('claude') includes an inline JSON schema example with a worked row", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.ok(p.includes("\"rows\""), "must show the rows key");
  assert.ok(p.includes("\"driverNameOnDoc\""), "must show driverNameOnDoc key");
  assert.ok(p.includes("\"resolvedKfiId\""), "must show resolvedKfiId key");
  assert.ok(p.includes("\"2026-05-10\""), "sample row must anchor date in the week window");
  assert.ok(/"timeIn":\s*"\d{1,2}:\d{2} (AM|PM)"/.test(p), "must show timeIn format");
  assert.ok(/"hours":\s*\d/.test(p), "must show hours as a decimal");
});

test("buildPrompt('claude') puts the schema example LAST (after the roster)", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  const rosterIdx = p.indexOf("KNOWN DRIVERS");
  const schemaIdx = p.indexOf("Output format");
  assert.ok(rosterIdx > 0, "roster section must be present");
  assert.ok(schemaIdx > rosterIdx, "Output format section must come after the roster");
});

test("buildPrompt('claude') explicitly forbids markdown fences and prose", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  // Two reinforcements — once in the Rules block, once next to the schema.
  assert.match(p, /No ```json fences/);
  assert.match(p, /No prose before or after/);
  assert.match(p, /Start with `\{` and end with `\}`/);
});

test("buildPrompt('claude') warns omit-don't-null and never-invent", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.match(p, /omitted \(not set to null\)/);
  assert.match(p, /Do not invent rows/);
  assert.match(p, /partial extract is fine; fabrication is not/);
});

test("buildPrompt() default (Gemini) is unchanged — first line still the original framing", () => {
  // Gemini's responseSchema enforces output format natively; we deliberately
  // do NOT add the Claude-style inline example or fence-ban here.
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster);
  assert.match(
    p,
    /^You are extracting timecard punches from a payroll export uploaded for customer "Adient"\.$/m,
  );
  assert.ok(!p.includes("payroll-data extractor"), "must not pick up Claude framing");
  assert.ok(!p.includes("```"), "must not include the inline JSON example fence");
  assert.ok(!p.includes("Output format"), "must not include the Claude-only Output format section");
});

test("buildPrompt('gemini') (explicit) also follows the default Gemini shape", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "gemini");
  assert.match(p, /Return strictly JSON matching the provided schema\./);
  assert.ok(!p.includes("payroll-data extractor"));
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
