import { test } from "node:test";
import assert from "node:assert/strict";

import { toDisplayName } from "../displayName.js";

test("toDisplayName: normalizes all-caps multi-word names", () => {
  assert.equal(
    toDisplayName("BENJAMIN RODRIGUEZ GONZALEZ"),
    "Benjamin Rodriguez Gonzalez",
  );
  assert.equal(toDisplayName("FELIX BAEZ CABALLERO"), "Felix Baez Caballero");
  assert.equal(toDisplayName("ROBERTO GOLAS QUEVEDO"), "Roberto Golas Quevedo");
});

test("toDisplayName: normalizes all-lower input", () => {
  assert.equal(toDisplayName("jane doe"), "Jane Doe");
});

test("toDisplayName: leaves mixed-case input untouched", () => {
  assert.equal(toDisplayName("John D. Smith"), "John D. Smith");
  assert.equal(toDisplayName("McDonald"), "McDonald");
  assert.equal(toDisplayName("d'Angelo"), "d'Angelo");
});

test("toDisplayName: Mc prefix capitalizes following letter", () => {
  assert.equal(toDisplayName("MCDONALD"), "McDonald");
  assert.equal(toDisplayName("MCCARTHY"), "McCarthy");
});

test("toDisplayName: apostrophe-aware (O'Brien, D'Angelo)", () => {
  assert.equal(toDisplayName("O'BRIEN"), "O'Brien");
  assert.equal(toDisplayName("D'ANGELO"), "D'Angelo");
  // curly apostrophe variant from Word/Excel exports
  assert.equal(toDisplayName("O\u2019BRIEN"), "O\u2019Brien");
});

test("toDisplayName: hyphenated surnames", () => {
  assert.equal(
    toDisplayName("RODRIGUEZ-GONZALEZ"),
    "Rodriguez-Gonzalez",
  );
  assert.equal(
    toDisplayName("MARY JANE SMITH-JONES"),
    "Mary Jane Smith-Jones",
  );
});

test("toDisplayName: preserves Roman-numeral suffixes", () => {
  assert.equal(toDisplayName("ROBERT SMITH II"), "Robert Smith II");
  assert.equal(toDisplayName("ROBERT SMITH III"), "Robert Smith III");
  assert.equal(toDisplayName("ROBERT SMITH IV"), "Robert Smith IV");
  assert.equal(toDisplayName("ROBERT SMITH V"), "Robert Smith V");
});

test("toDisplayName: preserves single-letter initials with trailing period", () => {
  assert.equal(toDisplayName("JOHN D. SMITH"), "John D. Smith");
  assert.equal(toDisplayName("J. R. R. TOLKIEN"), "J. R. R. Tolkien");
});

test("toDisplayName: particles capitalize each word (Van Der Berg)", () => {
  assert.equal(toDisplayName("VAN DER BERG"), "Van Der Berg");
});

test("toDisplayName: unicode-safe with accented letters", () => {
  assert.equal(toDisplayName("JOSÉ MARÍA"), "José María");
  assert.equal(toDisplayName("josé maría"), "José María");
});

test("toDisplayName: collapses runs of whitespace", () => {
  assert.equal(toDisplayName("  BENJAMIN   GONZALEZ  "), "Benjamin Gonzalez");
});

test("toDisplayName: passes through empty / null / undefined", () => {
  assert.equal(toDisplayName(""), "");
  assert.equal(toDisplayName(null), "");
  assert.equal(toDisplayName(undefined), "");
  assert.equal(toDisplayName("   "), "   ");
});

test("toDisplayName: punctuation-only / digit-only input is returned as-is", () => {
  assert.equal(toDisplayName("---"), "---");
  assert.equal(toDisplayName("12345"), "12345");
});
