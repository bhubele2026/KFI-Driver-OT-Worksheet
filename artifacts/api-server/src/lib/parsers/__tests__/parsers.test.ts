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
  /**
   * Pinned set of payroll/badge ids the parser is expected to surface as
   * unmapped for this fixture (sorted ascending). Most customer files for
   * these sample weeks include non-driver employees (warehouse, office,
   * other depots) that legitimately don't map to a KFI driver — pinning
   * them here means a *new* unmapped id (i.e. a real driver whose mapping
   * we forgot, or a parser regression that started dropping rows) shows up
   * as a loud diff instead of being silently swallowed. Refresh alongside
   * minPunches / totalHours when the fixture is rotated.
   */
  expectedUnmappedIds: string[];
  /**
   * Optional map of `id → expected sampleName` pinned for this fixture. Used
   * to lock in that a parser actually captures the employee name from the
   * source file's name column (Task #224) — a future refactor that drops the
   * name read will fail loudly here instead of silently regressing the
   * mapping dialog back to "(no name on doc)". Only a sampling per parser
   * is pinned; the full set lives in the source file itself.
   */
  expectedSampleNameById?: Record<string, string>;
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
    {
      file: "Adient.xlsx",
      customer: "Adient",
      minPunches: 5,
      totalHours: 50.0,
      tolerance: 0.5,
      // Adient's Kronos pivot includes every TELD employee at the depot;
      // only the handful that map through EMBEDDED_MAPPING are KFI drivers.
      expectedSampleNameById: {
        TELD1003: "ORTEGA, MIGUEL E",
        TELD1004: "YOSHIMURA, ROMEL",
      },
      expectedUnmappedIds: [
        "TELD1003", "TELD1004", "TELD1005", "TELD1006", "TELD1013",
        "TELD1023", "TELD1025", "TELD1026", "TELD1067", "TELD1068",
        "TELD1069", "TELD1120", "TELD1121", "TELD1123", "TELD1126",
        "TELD1127", "TELD1143", "TELD1144", "TELD1145", "TELD1146",
        "TELD1147", "TELD1148", "TELD1149", "TELD1154", "TELD1155",
        "TELD1156", "TELD1162", "TELD1163", "TELD1166", "TELD1167",
        "TELD1168", "TELD645",  "TELD647",  "TELD657",  "TELD659",
        "TELD662",  "TELD664",  "TELD679",  "TELD682",  "TELD686",
        "TELD687",  "TELD688",  "TELD689",  "TELD690",  "TELD706",
        "TELD720",  "TELD722",  "TELD723",  "TELD726",  "TELD740",
        "TELD742",  "TELD750",  "TELD788",  "TELD929",  "TELD943",
        "TELD944",  "TELD946",
      ],
    },
    {
      file: "Burnett_G.xlsx",
      customer: "Burnett Dairy - Grantsburg",
      minPunches: 15,
      totalHours: 140.38,
      tolerance: 0.5,
      expectedSampleNameById: {
        "74490468": "Mata, Miguel",
        "74490469": "Ayala, Andres",
      },
      expectedUnmappedIds: [
        "74490468", "74490469", "74490471", "74490472", "74490485",
        "74490497", "74490506", "74490507", "74490552", "74490554",
        "74490555", "74490556", "74490558", "74490559", "74490565",
        "74490569", "74490572", "74490578", "74490580", "74490584",
        "74490586", "74490587", "74490588", "74490589", "74490595",
        "74490597", "74490604", "74490608", "74490610", "74490611",
      ],
    },
    {
      file: "Greystone.xlsx",
      customer: "Greystone",
      minPunches: 42,
      totalHours: 323.4,
      tolerance: 0.5,
      expectedUnmappedIds: [],
    },
    {
      file: "Penda.xlsx",
      customer: "Penda",
      minPunches: 9,
      totalHours: 111.23,
      tolerance: 0.5,
      expectedSampleNameById: {
        "2000395": "Ayala, Sydney Marie",
        "2001117": "Rodriguez, Esequiel",
      },
      expectedUnmappedIds: [
        "2000395", "2001117", "2001231", "2001233", "2001234", "2001240",
        "2001245", "2001281", "2001286", "2001291", "2001305", "2001379",
        "2001457", "2001460", "2001467", "2001469", "2001470", "2001471",
        "2001473", "2001978", "2001984", "2001989", "2001997", "2002005",
        "2002010", "2002604", "2002622", "2002899", "2002992", "2002993",
        "2002994", "2002996", "2003002", "2003003", "2003004", "2003013",
        "2003014", "2003015", "2003016", "2003057", "2003061", "2003097",
        "2003098", "2003099", "2003101", "2003130", "2003134", "2003139",
        "2003140", "2003218", "2003228", "2003229", "2003230", "2003231",
        "2003238", "2003239", "2003241", "2003243", "2003244", "2003245",
        "2003246", "2003258", "2003259", "2003269", "2003272", "2003274",
        "2003275", "2003276", "2003280", "2003281", "2003282", "2003284",
        "2003285", "2003287", "2003290",
      ],
    },
    {
      file: "Trienda.xlsx",
      customer: "Trienda",
      minPunches: 4,
      totalHours: 47.03,
      tolerance: 0.5,
      expectedSampleNameById: {
        "2000598": "Carlos, Juan",
        "2000600": "Gonzalez, Jose",
      },
      expectedUnmappedIds: [
        "2000598", "2000600", "2000607", "2001115", "2001246", "2001249",
        "2001274", "2001287", "2001307", "2001677", "2001716", "2001719",
        "2001868", "2001875", "2001893", "2001905", "2002138", "2002428",
        "2002550", "2002551", "2002605", "2002609", "2002634", "2002898",
        "2002903", "2002908", "2002977", "2002979", "2002983", "2002984",
        "2002990", "2003021", "2003024", "2003025", "2003034", "2003039",
        "2003041", "2003068", "2003070", "2003083", "2003103", "2003104",
        "2003106", "2003108", "2003112", "2003114", "2003117", "2003121",
        "2003122", "2003133", "2003142", "2003143", "2003163", "2003214",
        "2003221", "2003227", "2003270", "2003271", "2003273", "2003277",
        "2003278", "2003279", "2003288", "2003289", "2003291", "2003292",
        "2003293",
      ],
    },
    {
      file: "LSI.xlsx",
      customer: "Landscape Structures",
      minPunches: 24,
      totalHours: 116.56,
      tolerance: 0.5,
      // LSI's export uses a position-id format suffixed with "N" for
      // non-driver staff; none of these are KFI drivers.
      expectedSampleNameById: {
        "04588028N": "Franklin, Nicholas",
        "04892360N": "Womack, Gabriel",
      },
      expectedUnmappedIds: [
        "04588028N", "04892360N", "05914223N", "07882138N", "11951467N",
        "20944976N", "23984111N", "24193668N", "27849992N", "28302936N",
        "31334663N", "42341780N", "49664830N", "50984048N", "51254707N",
        "51318267N", "51464917N", "51797079N", "58646949N", "64754291N",
        "70214351N", "73484504N", "82166372N", "85053954N", "89322622N",
        "91285905N", "95634502N",
      ],
    },
    {
      file: "Zenople.xlsx",
      customer: "Zenople",
      minPunches: 231,
      totalHours: 2135.0,
      tolerance: 0.5,
      expectedUnmappedIds: [],
    },
    {
      file: "IWG.pdf",
      customer: "International Wire Group",
      minPunches: 5,
      totalHours: 45.0,
      tolerance: 0.5,
      // IWG badges that aren't in EMBEDDED_MAPPING — non-KFI plant staff.
      expectedSampleNameById: {
        "104652": "Disla-Rosario, Juan",
        "104654": "Ortiz, Jacobo",
      },
      expectedUnmappedIds: [
        "104652", "104654", "104656", "104658", "104664",
        "104666", "104668", "104669", "104671",
      ],
    },
    // DeLallo is a scanned (image-only) PDF that goes through the Gemini OCR
    // fallback in pdf.ts. Only badge 3619 is in EMBEDDED_MAPPING for this
    // fixture week, so the parser keeps ~10 punches totaling ~40h after the
    // OCR pass. OCR is non-deterministic, so the tolerance is intentionally
    // wide — it's meant to catch parser/routing/OCR-prompt drift, not
    // row-by-row variance. The unmapped badges below are the other DeLallo
    // employees on the timesheet that aren't KFI drivers; OCR variance can
    // legitimately add or drop one row, so this list is checked as a
    // superset rather than an exact match.
    {
      file: "DeLallo.pdf",
      customer: "DeLallo",
      // OCR variance can legitimately add or drop a row; the typical result
      // is ~10 punches, so the floor is set well below that to avoid
      // flapping while still catching a parser regression that drops most
      // rows.
      minPunches: 5,
      totalHours: 41.5,
      tolerance: 8.0,
      expectedUnmappedIds: ["3618", "3620", "3623", "3636", "3637"],
    },
  ],
  // Second fixture week added during Task #221 (Connecteam-vs-customer
  // comparison work). Only Adient was pinned at the time; baseline values
  // captured here on 2026-05-19 against the same Kronos pivot export.
  "2026-05-10": [
    {
      file: "Adient.xlsx",
      customer: "Adient",
      minPunches: 5,
      totalHours: 52.0,
      tolerance: 0.5,
      expectedSampleNameById: {
        TELD1003: "ORTEGA, MIGUEL E",
        TELD1004: "YOSHIMURA, ROMEL",
      },
      expectedUnmappedIds: [
        "TELD1003", "TELD1004", "TELD1005", "TELD1006", "TELD1013",
        "TELD1023", "TELD1025", "TELD1026", "TELD1067", "TELD1068",
        "TELD1069", "TELD1120", "TELD1121", "TELD1123", "TELD1126",
        "TELD1127", "TELD1143", "TELD1144", "TELD1145", "TELD1146",
        "TELD1147", "TELD1148", "TELD1149", "TELD1154", "TELD1155",
        "TELD1156", "TELD1162", "TELD1163", "TELD1166", "TELD1167",
        "TELD1168", "TELD1173", "TELD1174", "TELD1177", "TELD645",
        "TELD647",  "TELD657",  "TELD659",  "TELD662",  "TELD664",
        "TELD679",  "TELD682",  "TELD686",  "TELD687",  "TELD688",
        "TELD689",  "TELD690",  "TELD706",  "TELD720",  "TELD723",
        "TELD740",  "TELD742",  "TELD750",  "TELD788",  "TELD929",
        "TELD943",  "TELD944",  "TELD946",
      ],
    },
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
// Task #150 / follow-up #194: skip Gemini OCR drift unconditionally on CI.
// The live OCR call is non-deterministic enough that the ±8h tolerance can
// be exceeded on a clean run, red-lining the pre-merge gate even when the
// codebase hasn't changed. Set `RUN_GEMINI_OCR_DRIFT=1` to opt back in.
const geminiSkipReason =
  process.env.RUN_GEMINI_OCR_DRIFT === "1" &&
  process.env.AI_INTEGRATIONS_GEMINI_API_KEY &&
  process.env.AI_INTEGRATIONS_GEMINI_BASE_URL
    ? null
    : "Gemini OCR drift test is opt-in (set RUN_GEMINI_OCR_DRIFT=1) — see follow-up #194.";

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
      // Contract guard: pin the exact set of badge/payroll ids the parser
      // is expected to surface as unmapped for this fixture. Any new id
      // (a real driver whose mapping went missing, or a parser change that
      // started dropping rows) shows up as a loud diff. DeLallo is the one
      // exception — OCR variance can legitimately add or drop one row, so
      // we only require the pinned ids to be a subset of what's reported.
      // `result.unmappedIds` is now `UnmappedIdEntry[]` (Task #52 added the
      // `count` + `sampleName` fields for the admin UI). The pinned baselines
      // are `string[]`, so compare on the id field.
      const got = result.unmappedIds.map((u) => u.id).sort();
      const want = [...e.expectedUnmappedIds].sort();
      if (e.file === "DeLallo.pdf") {
        const gotSet = new Set(got);
        for (const id of want) {
          assert.ok(
            gotSet.has(id),
            `expected unmapped id ${id} missing from ${JSON.stringify(got)}`,
          );
        }
      } else {
        assert.deepEqual(
          got,
          want,
          `unmappedIds drift for ${e.file}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
        );
      }
      // Task #224: pin sampleName capture for parsers that read an
      // employee-name column from the source file. The mapping dialog
      // shows "(no name on doc)" when sampleName is null, so silently
      // losing this read regresses the dispatcher's UX badly. Pinning
      // one or two ids per parser is enough to catch a regression.
      if (e.expectedSampleNameById) {
        const byId = new Map(
          result.unmappedIds.map((u) => [u.id, u.sampleName] as const),
        );
        for (const [id, expectedName] of Object.entries(e.expectedSampleNameById)) {
          assert.ok(
            byId.has(id),
            `expectedSampleNameById id ${id} not in unmappedIds for ${e.file}`,
          );
          assert.equal(
            byId.get(id),
            expectedName,
            `sampleName drift for ${e.file} id ${id}: got ${JSON.stringify(byId.get(id))}, want ${JSON.stringify(expectedName)}`,
          );
        }
      }
      // Sanity: every punch should have non-empty kfiId, date, and positive hours.
      for (const p of result.punches) {
        assert.ok(p.kfiId, `punch missing kfiId: ${JSON.stringify(p)}`);
        assert.ok(p.date, `punch missing date: ${JSON.stringify(p)}`);
        assert.ok(p.hours > 0, `punch has non-positive hours: ${JSON.stringify(p)}`);
      }
    });
  }
}

// Negative case: deliberately strip one driver id from the seeded roster and
// confirm the parser (a) drops that driver's punches and (b) reports the
// badge/employee id back via unmappedIds. This is what surfaces a new hire's
// missing mapping to the dispatcher instead of silently losing payroll rows.
test("Greystone: dropping a known driver id surfaces it in unmappedIds", async () => {
  const weekStart = "2026-04-26";
  const file = "Greystone.xlsx";
  const buf = readFileSync(path.join(fixtureDir, weekStart, file));

  // Baseline parse with the full roster so we know exactly how many punches
  // the chosen victim contributes for this fixture week.
  const full = await detectAndParseFile(file, buf, KFI_SET, weekStart);
  assert.ok(full, "baseline parse failed");

  // Pick the victim deterministically: the kfiId with the most punches in
  // this fixture, breaking ties by id. Greystone uses the payroll id as the
  // kfiId directly, so the same string round-trips into unmappedIds.
  const counts = new Map<string, number>();
  for (const p of full.punches) {
    counts.set(p.kfiId, (counts.get(p.kfiId) ?? 0) + 1);
  }
  const victim = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  assert.ok(victim, "no punches to choose a victim from");
  const [victimId, victimPunchCount] = victim;
  assert.ok(victimPunchCount > 0, "victim contributes no punches");

  const partial = new Set(KFI_SET);
  partial.delete(victimId);

  const result = await detectAndParseFile(file, buf, partial, weekStart);
  assert.ok(result, "partial parse failed");

  // The victim should be reported back exactly once (Set semantics) and no
  // surviving punch should still reference them. `unmappedIds` is now an
  // array of `UnmappedIdEntry` objects (Task #52); compare on the id field.
  const unmappedVictimEntries = result.unmappedIds.filter(
    (u) => u.id === victimId,
  );
  assert.ok(
    unmappedVictimEntries.length > 0,
    `expected ${victimId} in unmappedIds, got ${JSON.stringify(result.unmappedIds)}`,
  );
  assert.equal(
    unmappedVictimEntries.length,
    1,
    "unmappedIds should be deduplicated",
  );
  assert.equal(
    result.punches.filter((p) => p.kfiId === victimId).length,
    0,
    "victim punches leaked into the result",
  );
  // The number of dropped punches must match what the victim contributed in
  // the baseline — otherwise the parser is dropping rows it shouldn't, or
  // keeping rows it shouldn't.
  assert.equal(
    full.punches.length - result.punches.length,
    victimPunchCount,
    `expected ${victimPunchCount} punches dropped, got ${full.punches.length - result.punches.length}`,
  );
});

test("unknown filename routes to null", async () => {
  const result = await detectAndParseFile(
    "random_file.xlsx",
    Buffer.alloc(0),
    KFI_SET,
    "2026-04-26",
  );
  assert.equal(result, null);
});

test("explicit customer forces parser even when filename matches another customer", async () => {
  // Regression: a Greystone XLSX with an unrelated filename, dropped on
  // the Penda row, must parse as Penda — never let the filename
  // keyword scan re-route to Greystone. With explicitCustomer, the
  // parser dispatches strictly by the explicit choice; here Penda's
  // parser will return zero rows from a Greystone-shaped sheet, but
  // the routing decision itself must be honored.
  const weekStart = "2026-04-26";
  const buf = readFileSync(path.join(fixtureDir, weekStart, "Greystone.xlsx"));

  // Without explicit customer: filename routes to Greystone (truthy).
  const detected = await detectAndParseFile(
    "Greystone.xlsx",
    buf,
    KFI_SET,
    weekStart,
  );
  assert.ok(detected, "filename routing should detect Greystone");
  assert.equal(detected.customer, "Greystone");

  // With explicitCustomer=Penda: dispatched to Penda's parser regardless
  // of the filename's "greystone" keyword.
  const forced = await detectAndParseFile(
    "Greystone.xlsx",
    buf,
    KFI_SET,
    weekStart,
    undefined,
    "Penda",
  );
  assert.ok(forced, "explicit customer should route to Penda");
  assert.equal(
    forced.customer,
    "Penda",
    "explicit customer must override filename keyword routing",
  );
});
