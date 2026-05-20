/**
 * Pins the Claude- and Gemini-tailored prompt shapes.
 *
 * Task #340: the Task #308 NDJSON-specific assertions previously in
 * this file have been removed — the runtime never shipped the NDJSON
 * cut-over those tests pinned (`parseOrSalvage` still parses the
 * `{ "rows": [...] }` wrapper, and the prompts ship the same wrapper
 * as their worked example). What remains here is the shape contract
 * that IS still in the live prompts: Claude's concrete domain framing,
 * the wrapper-shaped JSON example placed after the roster, the
 * explicit "no fences, no prose" guidance, and the roster cap.
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

test("buildPrompt('claude') includes an inline JSON example with a worked row", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.ok(p.includes('"driverNameOnDoc"'), "must show driverNameOnDoc key");
  assert.ok(p.includes('"resolvedKfiId"'), "must show resolvedKfiId key");
  assert.ok(p.includes(`"${"2026-05-10"}"`), "sample row must anchor date in the week window");
  assert.ok(/"timeIn":\s*"\d{1,2}:\d{2} (AM|PM)"/.test(p), "must show timeIn format");
  assert.ok(/"hours":\s*\d/.test(p), "must show hours as a decimal");
});

test("buildPrompt('claude') puts the Output format section LAST (after the roster)", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  const rosterIdx = p.indexOf("KNOWN DRIVERS");
  const schemaIdx = p.indexOf("Output format");
  assert.ok(rosterIdx > 0, "roster section must be present");
  assert.ok(schemaIdx > rosterIdx, "Output format section must come after the roster");
});

test("buildPrompt('claude') explicitly forbids markdown fences and prose", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.match(p, /No ```json fences/);
  assert.match(p, /No prose before or after/);
});

test("buildPrompt('claude') warns omit-don't-null and never-invent", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster, "claude");
  assert.match(p, /omitted \(not set to null\)/);
  assert.match(p, /Do not invent rows/);
  assert.match(p, /partial extract is fine; fabrication is not/);
});

test("buildPrompt() default (Gemini) keeps its own framing", () => {
  const p = buildPrompt("Adient", "2026-05-10", "2026-05-16", roster);
  assert.match(p, /^You are extracting timecard punches/m);
  assert.ok(!p.includes("payroll-data extractor"), "must not pick up Claude framing");
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
