/**
 * Task #441: signature stability against cosmetic header shuffles.
 *
 * The schema-cache fast path keys on the SHA-256 of the file's
 * normalized header row. Vendors routinely shuffle column order
 * week-to-week (swap "Hours" and "Date", append a "Cost Center"
 * column, etc.) without changing the data shape. The generic role
 * reader matches roles by column NAME, not position, so the cached
 * recipe still works — but only if the signature stays the same.
 *
 * Pure unit test: no DB, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { computeHeaderSignature } from "../schemaSignature.js";

function buildXlsx(headers: string[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([headers, ["x", "x", "x", "x", "x"]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

test("xlsx header signature is identical when columns are reordered", async () => {
  const a = buildXlsx(["Badge", "Date", "Time In", "Time Out", "Hours"]);
  const b = buildXlsx(["Hours", "Time Out", "Date", "Badge", "Time In"]);
  const sigA = await computeHeaderSignature("export.xlsx", a);
  const sigB = await computeHeaderSignature("export.xlsx", b);
  assert.ok(sigA, "expected a signature for the first layout");
  assert.ok(sigB, "expected a signature for the shuffled layout");
  assert.equal(
    sigA,
    sigB,
    "shuffled headers should hash to the same signature",
  );
});

test("xlsx header signature still changes when column NAMES differ", async () => {
  const a = buildXlsx(["Badge", "Date", "Time In", "Time Out", "Hours"]);
  // Same columns + a new "Cost Center" column — signature must change so
  // a meaningful layout change still busts the cache.
  const b = buildXlsx([
    "Badge",
    "Date",
    "Time In",
    "Time Out",
    "Hours",
    "Cost Center",
  ]);
  const sigA = await computeHeaderSignature("export.xlsx", a);
  const sigB = await computeHeaderSignature("export.xlsx", b);
  assert.ok(sigA && sigB);
  assert.notEqual(
    sigA,
    sigB,
    "adding a real new column should change the signature",
  );
});
