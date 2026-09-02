import test from "node:test";
import assert from "node:assert/strict";
import { parseTagNumberInput } from "../driverTagNumber.js";

test("null and undefined clear the tag", () => {
  assert.deepEqual(parseTagNumberInput(null), { ok: true, value: null });
  assert.deepEqual(parseTagNumberInput(undefined), { ok: true, value: null });
});

test("strings are trimmed; empty after trim clears", () => {
  assert.deepEqual(parseTagNumberInput("  10020908  "), {
    ok: true,
    value: "10020908",
  });
  assert.deepEqual(parseTagNumberInput(""), { ok: true, value: null });
  assert.deepEqual(parseTagNumberInput("   "), { ok: true, value: null });
});

test("alphanumeric badges are accepted as-is", () => {
  assert.deepEqual(parseTagNumberInput("WB-10020908a"), {
    ok: true,
    value: "WB-10020908a",
  });
});

test("oversize is rejected", () => {
  const r = parseTagNumberInput("x".repeat(33));
  assert.equal(r.ok, false);
});

test("control and format characters are rejected", () => {
  assert.equal(parseTagNumberInput("100\n20908").ok, false);
  // zero-width space is Cf — invisible characters must not sneak into a badge
  assert.equal(parseTagNumberInput("100​20908").ok, false);
});

test("non-strings are rejected", () => {
  assert.equal(parseTagNumberInput(10020908).ok, false);
  assert.equal(parseTagNumberInput({ tag: "x" }).ok, false);
  assert.equal(parseTagNumberInput(true).ok, false);
});
