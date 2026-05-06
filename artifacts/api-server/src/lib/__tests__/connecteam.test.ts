import test from "node:test";
import assert from "node:assert/strict";
import { coerceCustomFieldValue } from "../connecteam.js";

// Regression guard for the Connecteam custom-field corruption fixed in
// tasks #30 and #32. Naive String() of a dropdown payload yields the literal
// "[object Object]" and leaks into drivers.customer, which then surfaces as a
// giant catch-all sidebar group on the dashboard. coerceCustomFieldValue must
// unwrap the realistic payload shapes into a plain string (or undefined) and
// must NEVER return "[object Object]".

test("coerceCustomFieldValue: plain string passes through", () => {
  assert.equal(coerceCustomFieldValue("Adient"), "Adient");
});

test("coerceCustomFieldValue: empty string becomes undefined", () => {
  assert.equal(coerceCustomFieldValue(""), undefined);
});

test("coerceCustomFieldValue: null and undefined become undefined", () => {
  assert.equal(coerceCustomFieldValue(null), undefined);
  assert.equal(coerceCustomFieldValue(undefined), undefined);
});

test("coerceCustomFieldValue: numbers and booleans stringify", () => {
  assert.equal(coerceCustomFieldValue(42), "42");
  assert.equal(coerceCustomFieldValue(0), "0");
  assert.equal(coerceCustomFieldValue(true), "true");
});

test("coerceCustomFieldValue: dropdown array [{ id, value }] unwraps to value", () => {
  const dropdown = [{ id: 12345, value: "IWG" }];
  assert.equal(coerceCustomFieldValue(dropdown), "IWG");
});

test("coerceCustomFieldValue: multi-select dropdown joins values", () => {
  const dropdown = [
    { id: 1, value: "Adient" },
    { id: 2, value: "IWG" },
  ];
  assert.equal(coerceCustomFieldValue(dropdown), "Adient, IWG");
});

test("coerceCustomFieldValue: single object { value } unwraps", () => {
  assert.equal(coerceCustomFieldValue({ value: "DeLallo" }), "DeLallo");
});

test("coerceCustomFieldValue: object with name fallback unwraps", () => {
  assert.equal(coerceCustomFieldValue({ name: "Penda" }), "Penda");
});

test("coerceCustomFieldValue: nested wrapper { value: { value } } unwraps", () => {
  assert.equal(
    coerceCustomFieldValue({ value: { value: "Trienda" } }),
    "Trienda",
  );
});

test("coerceCustomFieldValue: array wrapping object wrapping value unwraps", () => {
  assert.equal(
    coerceCustomFieldValue([{ value: { value: "Greystone" } }]),
    "Greystone",
  );
});

test("coerceCustomFieldValue: empty array becomes undefined", () => {
  assert.equal(coerceCustomFieldValue([]), undefined);
});

test("coerceCustomFieldValue: array of empty/null entries becomes undefined", () => {
  assert.equal(coerceCustomFieldValue([null, "", { value: null }]), undefined);
});

test("coerceCustomFieldValue: object with no usable inner value becomes undefined", () => {
  assert.equal(coerceCustomFieldValue({ id: 99 }), undefined);
  assert.equal(coerceCustomFieldValue({}), undefined);
});

test("coerceCustomFieldValue: never returns the literal '[object Object]'", () => {
  const shapes: unknown[] = [
    [{ id: 1, value: "Adient" }],
    { value: "IWG" },
    { name: "Penda" },
    { value: { value: "Trienda" } },
    [{ value: { value: "Greystone" } }],
    [
      { id: 1, value: "Adient" },
      { id: 2, value: "IWG" },
    ],
    {},
    { id: 7 },
    [],
    [null, ""],
    null,
    undefined,
    "",
    "Burnett",
    42,
    true,
  ];
  for (const shape of shapes) {
    const out = coerceCustomFieldValue(shape);
    assert.notEqual(
      out,
      "[object Object]",
      `coerceCustomFieldValue(${JSON.stringify(shape)}) must not return "[object Object]"`,
    );
    if (out !== undefined) {
      assert.doesNotMatch(
        out,
        /\[object Object\]/,
        `coerceCustomFieldValue(${JSON.stringify(shape)}) must not contain "[object Object]" (got ${out})`,
      );
    }
  }
});
