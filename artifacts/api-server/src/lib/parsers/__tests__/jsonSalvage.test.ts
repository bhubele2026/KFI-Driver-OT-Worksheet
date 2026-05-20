/**
 * Unit tests for `parseOrSalvageJsonObject` — the shared JSON salvage
 * helper used by both the main AI extraction pipeline and the DeLallo
 * OCR fallback (Task #348). Verifies that a deliberately truncated /
 * comma-broken OCR response yields the recoverable row prefix, and
 * that fully-broken input still throws with the customizable prefix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrSalvageJsonObject } from "../jsonSalvage.js";

type OcrPunchRow = {
  badge: string;
  name?: string;
  date: string;
  hours: number;
};

function makeRow(i: number): string {
  return `{"badge":"${1000 + i}","name":"DOE, JANE ${i}","date":"06/0${i}","clockIn":"7:00 AM","clockOut":"3:30 PM","hours":8.5}`;
}

test("clean JSON parses without salvage and is not marked truncated", () => {
  const raw = `{"punches":[${makeRow(1)},${makeRow(2)}]}`;
  const { parsed, truncated } = parseOrSalvageJsonObject<{
    punches?: OcrPunchRow[];
  }>(raw, { errorPrefix: "DeLallo OCR fallback" });
  assert.equal(truncated, false);
  assert.equal(parsed.punches?.length, 2);
  assert.equal(parsed.punches?.[0].badge, "1001");
});

test("salvages JSON truncated mid-row, returning the complete prefix", () => {
  // Model produced two full rows then got cut off partway through the third.
  const broken = `{"punches":[${makeRow(1)},${makeRow(2)},{"badge":"1003","name":"DOE, J`;
  const warnings: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
  const { parsed, truncated } = parseOrSalvageJsonObject<{
    punches?: OcrPunchRow[];
  }>(broken, {
    errorPrefix: "DeLallo OCR fallback",
    log: { warn: (ctx, msg) => warnings.push({ ctx, msg }) },
    logCtx: { fileName: "scan.pdf" },
  });
  assert.equal(truncated, true);
  assert.equal(parsed.punches?.length, 2);
  assert.equal(parsed.punches?.[1].badge, "1002");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /salvaged truncated JSON response/);
  assert.equal(warnings[0].ctx.fileName, "scan.pdf");
});

test("salvages JSON with a stray trailing comma after the last row", () => {
  // A trailing comma is exactly the failure shape called out in the
  // task description ("Expected ',' or '}' at position …").
  const broken = `{"punches":[${makeRow(1)},${makeRow(2)},]}`;
  const { parsed, truncated } = parseOrSalvageJsonObject<{
    punches?: OcrPunchRow[];
  }>(broken, { errorPrefix: "DeLallo OCR fallback" });
  assert.equal(truncated, true);
  assert.equal(parsed.punches?.length, 2);
});

test("salvages trailing prose / duplicate object after a valid prefix", () => {
  const raw = `{"punches":[${makeRow(1)}]}\n\nHere is the JSON again: {"punches":[]}`;
  const warnings: Array<{ msg: string }> = [];
  const { parsed, truncated } = parseOrSalvageJsonObject<{
    punches?: OcrPunchRow[];
  }>(raw, {
    errorPrefix: "DeLallo OCR fallback",
    log: { warn: (_ctx, msg) => warnings.push({ msg }) },
  });
  assert.equal(truncated, false);
  assert.equal(parsed.punches?.length, 1);
  assert.match(warnings[0].msg, /salvaged JSON prefix/);
});

test("strips markdown fences before parsing", () => {
  const raw = "```json\n" + `{"punches":[${makeRow(1)}]}` + "\n```";
  const { parsed, truncated } = parseOrSalvageJsonObject<{
    punches?: OcrPunchRow[];
  }>(raw, { errorPrefix: "DeLallo OCR fallback" });
  assert.equal(truncated, false);
  assert.equal(parsed.punches?.length, 1);
});

test("throws with the configured prefix when nothing can be recovered", () => {
  // Cut off before any row object completes — salvage has nothing to keep.
  const raw = `{"punches":[{"badge":"1001","name":"DOE`;
  assert.throws(
    () =>
      parseOrSalvageJsonObject<{ punches?: OcrPunchRow[] }>(raw, {
        errorPrefix: "DeLallo OCR fallback",
      }),
    /^Error: DeLallo OCR fallback: model response was truncated before any complete row/,
  );
});

test("throws with the configured prefix for total garbage with no JSON", () => {
  assert.throws(
    () =>
      parseOrSalvageJsonObject<{ punches?: OcrPunchRow[] }>("not json at all", {
        errorPrefix: "DeLallo OCR fallback",
      }),
    /^Error: DeLallo OCR fallback: model did not return valid JSON/,
  );
});
