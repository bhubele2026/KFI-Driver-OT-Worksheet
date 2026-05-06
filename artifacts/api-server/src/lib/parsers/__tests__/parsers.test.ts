import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectAndParseFile } from "../index.js";
import type { ParsedPunch } from "../types.js";
import { EMBEDDED_MAPPING, IWG_DRIVER_IDS } from "../../mappings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures");
const WEEK_START = "2026-04-26";

// Snapshot of KFI driver ids that appear in the fixture files. Several
// customer parsers (Greystone, Zenople, Burnett, Penda/Trienda) treat the
// payroll id as the kfi id directly when it isn't in EMBEDDED_MAPPING, so the
// test must seed those ids explicitly. Captured 2026-05-06 from the
// 04/26-05/02/2026 sample exports — refresh when the roster changes.
const FIXTURE_KFI_IDS = [
  // Greystone
  "2005077", "2005024", "2005094", "2005103", "2004818",
  "2005136", "2005023", "2005141", "2005022", "2005098",
  // Zenople
  "2001159", "2001504", "2001872", "2002254", "2002420", "2002627",
  "2003300", "2003568", "2003590", "2003771", "2004278", "2004445",
  "2004446", "2004449", "2004451", "2004452", "2004465", "2004490",
  "2004584", "2004747", "2004749", "2004750", "2004767", "2004768",
  "2004774", "2004787", "2004795", "2004797", "2004866", "2004939",
  "2004944", "2004992", "2005033", "2005079", "2005083", "2005084",
  "2005089", "2005093", "2005113", "2005114", "2005115", "2005156",
  "2005213", "2005214", "2005215", "2005216", "2005217",
];

const KFI_SET = new Set<string>([
  ...Object.values(EMBEDDED_MAPPING),
  ...IWG_DRIVER_IDS,
  ...FIXTURE_KFI_IDS,
]);

interface Expected {
  file: string;
  customer: string;
  /** Minimum punch count (drift-tolerant lower bound). */
  minPunches: number;
  /** Expected total hours for the sample week. */
  totalHours: number;
  /** Allowed absolute deviation in total hours. */
  tolerance: number;
}

// Baselines captured 2026-05-06 by running the parsers against the 04/26-05/02
// sample files. If a parser legitimately changes (new customer columns, etc.)
// re-capture these numbers; if a parser silently drifts, the assertion fires.
// Tolerance is 0.5h to allow rounding noise but catch any real format drift.
const EXPECTED: Expected[] = [
  { file: "Adient.xlsx",    customer: "Adient",                     minPunches:   5, totalHours:   50.00, tolerance: 0.5 },
  { file: "Burnett_G.xlsx", customer: "Burnett Dairy - Grantsburg", minPunches:  15, totalHours:  140.38, tolerance: 0.5 },
  { file: "Greystone.xlsx", customer: "Greystone",                  minPunches:  42, totalHours:  323.40, tolerance: 0.5 },
  { file: "Penda.xlsx",     customer: "Penda",                      minPunches:   9, totalHours:  111.23, tolerance: 0.5 },
  { file: "Trienda.xlsx",   customer: "Trienda",                    minPunches:   4, totalHours:   47.03, tolerance: 0.5 },
  { file: "LSI.xlsx",       customer: "Landscape Structures",       minPunches:  24, totalHours:  116.56, tolerance: 0.5 },
  { file: "Zenople.xlsx",   customer: "Zenople",                    minPunches: 231, totalHours: 2135.00, tolerance: 0.5 },
  { file: "IWG.pdf",        customer: "International Wire Group",   minPunches:   5, totalHours:   45.00, tolerance: 0.5 },
];

function totalHours(punches: ParsedPunch[]): number {
  return Math.round(punches.reduce((s, p) => s + p.hours, 0) * 1000) / 1000;
}

for (const e of EXPECTED) {
  test(`${e.customer}: ${e.file} parses without drift`, async () => {
    const buf = readFileSync(path.join(fixtureDir, e.file));
    const result = await detectAndParseFile(e.file, buf, KFI_SET, WEEK_START);
    assert.ok(result, `parser routing failed for ${e.file}`);
    assert.equal(result.customer, e.customer);
    assert.ok(
      result.punches.length >= e.minPunches,
      `expected at least ${e.minPunches} punches, got ${result.punches.length}`,
    );
    const total = totalHours(result.punches);
    assert.ok(
      Math.abs(total - e.totalHours) <= e.tolerance,
      `total hours ${total} outside tolerance ±${e.tolerance} of ${e.totalHours}`,
    );
    // Sanity: every punch should have non-empty kfiId, date, and positive hours.
    for (const p of result.punches) {
      assert.ok(p.kfiId, `punch missing kfiId: ${JSON.stringify(p)}`);
      assert.ok(p.date, `punch missing date: ${JSON.stringify(p)}`);
      assert.ok(p.hours > 0, `punch has non-positive hours: ${JSON.stringify(p)}`);
    }
  });
}

test("unknown filename routes to null", async () => {
  const result = await detectAndParseFile(
    "random_file.xlsx",
    Buffer.alloc(0),
    KFI_SET,
    WEEK_START,
  );
  assert.equal(result, null);
});
