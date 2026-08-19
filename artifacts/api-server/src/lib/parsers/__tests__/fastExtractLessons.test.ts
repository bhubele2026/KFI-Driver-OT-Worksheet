/**
 * Regression guard for the Task #406 lessons drop on the fast lane.
 *
 * `customer_extraction_lessons` turns a dispatcher's correction into a line
 * prepended to the extractor's prompt, so the model stops repeating the same
 * mistake for that customer. The route built the lessons array and handed it
 * to `extractImageForKnownCustomer` as `aiOpts.lessons` — but that function
 * forwarded `aiOpts` ONLY to the legacy `aiExtractRows`. The default lane
 * (`fastExtractRows`, FAST_IMPORT unset → "1") took no lessons parameter at
 * all, so every lesson was silently discarded in production: dispatchers
 * taught the app, the table filled up, and the extractor never read a word
 * of it.
 *
 * These tests pin the wiring at the prompt boundary — the cheapest place to
 * catch it, and the place that stayed silent last time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtractPrompt } from "../fastExtract.js";

const TARGETS = [{ name: "Joey C.", badge: "884", kfiId: "2005003" }];
const args = ["Penda Corp", "2026-08-09", "2026-08-15", TARGETS] as const;

test("fast lane renders per-customer lessons into the extract prompt", () => {
  const prompt = buildExtractPrompt(...args, [
    "Night shift rows on this sheet are dated the day the shift STARTED.",
  ]);
  assert.match(prompt, /Lessons learned from past dispatcher corrections/);
  assert.match(prompt, /dated the day the shift STARTED/);
});

test("lessons sit ABOVE the general instructions so they win on conflict", () => {
  const prompt = buildExtractPrompt(...args, ["Ignore the Scheduled column."]);
  const lessonAt = prompt.indexOf("Ignore the Scheduled column.");
  const generalAt = prompt.indexOf("You extract timecard punches");
  assert.ok(lessonAt >= 0 && generalAt >= 0);
  assert.ok(
    lessonAt < generalAt,
    "a lesson must precede the general instructions it is meant to override",
  );
});

test("no lessons → no lessons section (prompt stays lean for most customers)", () => {
  for (const lessons of [undefined, []]) {
    const prompt = buildExtractPrompt(...args, lessons);
    assert.doesNotMatch(prompt, /Lessons learned/);
    assert.match(prompt, /You extract timecard punches/);
  }
});
