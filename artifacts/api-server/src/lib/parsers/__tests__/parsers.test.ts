import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectAndParseFile } from "../index.js";
import type { ParsedPunch } from "../types.js";
import { EMBEDDED_MAPPING, IWG_DRIVER_IDS } from "../../mappings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures");

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

// ---------------------------------------------------------------------------
// Fixture rotation policy
// ---------------------------------------------------------------------------
// Fixtures live under `fixtures/<YYYY-MM-DD>/<File>` keyed by the Sunday week
// start. Each entry in BASELINES pins the parser output for one (week, file)
// pair so silent format drift fails loudly.
//
// HOW TO REFRESH (do this when a customer changes their export format, or at
// least once per quarter to keep the safety net meaningful):
//
//   1. Pick a recent week with a clean upload for each customer. Drop the raw
//      file into `fixtures/<week-start>/<Customer>.xlsx` (or .pdf), keeping
//      the same filename the routing layer expects (see KNOWN_CUSTOMERS in
//      `lib/parsers/customers.ts`).
//   2. Capture the baseline numbers by running the parser locally:
//        pnpm --filter @workspace/api-server exec tsx \
//          -e 'import("./src/lib/parsers/index.js").then(async ({ detectAndParseFile }) => {
//                const fs = await import("node:fs");
//                const buf = fs.readFileSync("<path-to-fixture>");
//                const r = await detectAndParseFile("<File>", buf, new Set(), "<week-start>");
//                console.log(r?.punches.length, r?.punches.reduce((s,p)=>s+p.hours,0));
//              })'
//      (or just add the file + a placeholder baseline and read the actual
//      numbers off the assertion failure once.)
//   3. Add a row to BASELINES with the captured `minPunches` and `totalHours`.
//      Keep tolerance at 0.5h unless you have a reason to widen it.
//   4. If a fixture week is older than ~3 quarters AND a newer week for the
//      same customer is already pinned, delete the stale fixture file and its
//      BASELINES row. Aim for 1-3 weeks of coverage per customer so a single
//      anomalous week never has to be both reference and verification.
//   5. If a customer roster changes, update FIXTURE_KFI_IDS above so the
//      seeded KFI_SET still matches every id present in the fixtures.
//
// Baselines below were captured 2026-05-06 against the 04/26-05/02/2026
// sample exports.
const BASELINES: Record<string, Expected[]> = {
  "2026-04-26": [
    { file: "Adient.xlsx",    customer: "Adient",                     minPunches:   5, totalHours:   50.00, tolerance: 0.5 },
    { file: "Burnett_G.xlsx", customer: "Burnett Dairy - Grantsburg", minPunches:  15, totalHours:  140.38, tolerance: 0.5 },
    { file: "Greystone.xlsx", customer: "Greystone",                  minPunches:  42, totalHours:  323.40, tolerance: 0.5 },
    { file: "Penda.xlsx",     customer: "Penda",                      minPunches:   9, totalHours:  111.23, tolerance: 0.5 },
    { file: "Trienda.xlsx",   customer: "Trienda",                    minPunches:   4, totalHours:   47.03, tolerance: 0.5 },
    { file: "LSI.xlsx",       customer: "Landscape Structures",       minPunches:  24, totalHours:  116.56, tolerance: 0.5 },
    { file: "Zenople.xlsx",   customer: "Zenople",                    minPunches: 231, totalHours: 2135.00, tolerance: 0.5 },
    { file: "IWG.pdf",        customer: "International Wire Group",   minPunches:   5, totalHours:   45.00, tolerance: 0.5 },
    // DeLallo is a scanned (image-only) PDF that goes through the Gemini OCR
    // fallback in pdf.ts. Only badge 3619 is in EMBEDDED_MAPPING for this
    // fixture week, so the parser keeps ~10 punches totaling ~40h after the
    // OCR pass. OCR is non-deterministic, so the tolerance is intentionally
    // wide — it's meant to catch parser/routing/OCR-prompt drift, not
    // row-by-row variance.
    { file: "DeLallo.pdf",    customer: "DeLallo",                    minPunches:   7, totalHours:   41.50, tolerance: 8.0 },
  ],
};

function totalHours(punches: ParsedPunch[]): number {
  return Math.round(punches.reduce((s, p) => s + p.hours, 0) * 1000) / 1000;
}

// Discover fixture week directories on disk and cross-check against
// BASELINES. Any week folder without a baseline entry (or vice-versa) is a
// loud failure — that catches the case where someone drops a new fixture in
// without pinning it, or removes a fixture without cleaning up the baseline.
const fixtureWeeks = readdirSync(fixtureDir)
  .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
  .filter((name) => statSync(path.join(fixtureDir, name)).isDirectory())
  .sort();

test("fixture directories and BASELINES agree", () => {
  const onDisk = new Set(fixtureWeeks);
  const inBaselines = new Set(Object.keys(BASELINES));
  for (const w of onDisk) {
    assert.ok(inBaselines.has(w), `fixture week ${w} has no BASELINES entry`);
  }
  for (const w of inBaselines) {
    assert.ok(onDisk.has(w), `BASELINES week ${w} has no fixture directory`);
  }
  assert.ok(fixtureWeeks.length > 0, "no fixture weeks found");

  // File-level guard: every fixture file inside a week directory must have a
  // matching BASELINES row, and every BASELINES row must point to a file that
  // actually exists. Otherwise someone could drop a new export into an
  // existing week (or delete one) without the drift suite noticing.
  for (const week of fixtureWeeks) {
    const filesOnDisk = new Set(
      readdirSync(path.join(fixtureDir, week)).filter(
        (n) => !n.startsWith(".") && n !== "README.md",
      ),
    );
    const filesInBaselines = new Set((BASELINES[week] ?? []).map((e) => e.file));
    for (const f of filesOnDisk) {
      assert.ok(
        filesInBaselines.has(f),
        `fixture ${week}/${f} has no BASELINES entry`,
      );
    }
    for (const f of filesInBaselines) {
      assert.ok(
        filesOnDisk.has(f),
        `BASELINES entry ${week}/${f} has no fixture file on disk`,
      );
    }
  }
});

// Some fixtures depend on the Gemini OCR fallback (scanned PDFs with no text
// layer). Those tests should be skipped — not failed — when the AI
// Integrations env vars aren't wired up, so contributors without OCR access
// can still run the suite cleanly.
const GEMINI_OCR_FILES = new Set(["DeLallo.pdf"]);
const geminiSkipReason =
  process.env.AI_INTEGRATIONS_GEMINI_API_KEY &&
  process.env.AI_INTEGRATIONS_GEMINI_BASE_URL
    ? null
    : "AI_INTEGRATIONS_GEMINI_API_KEY / AI_INTEGRATIONS_GEMINI_BASE_URL not configured — skipping Gemini OCR drift test.";

for (const weekStart of fixtureWeeks) {
  const expected = BASELINES[weekStart] ?? [];
  for (const e of expected) {
    const skip =
      GEMINI_OCR_FILES.has(e.file) && geminiSkipReason ? geminiSkipReason : undefined;
    test(`${weekStart} ${e.customer}: ${e.file} parses without drift`, { skip }, async () => {
      const buf = readFileSync(path.join(fixtureDir, weekStart, e.file));
      const result = await detectAndParseFile(e.file, buf, KFI_SET, weekStart);
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
}

test("unknown filename routes to null", async () => {
  const result = await detectAndParseFile(
    "random_file.xlsx",
    Buffer.alloc(0),
    KFI_SET,
    "2026-04-26",
  );
  assert.equal(result, null);
});
