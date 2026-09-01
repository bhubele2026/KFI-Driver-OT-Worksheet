/**
 * 2026-09-01 ignore-veto enforcement (Davis→Navarro incident).
 *
 * "Not a driver — never import" rules used to be consulted only when
 * quieting the picker prompt — no matcher ever read them, so a saved
 * badge/name alias imported an explicitly-ignored worker's rows under
 * the aliased driver (LSI's David Davis landed under Shusters' David
 * Navarro). These tests pin the veto: keyed on the DOC-side identity
 * (badge + `name:` sentinel), applied BEFORE every matching lane, and
 * routing vetoed rows to droppedRows — never to the picker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NAME_KEY_PREFIX,
  ignoreKeysForRow,
  ignoreClearKeysForPick,
  isIgnoredRow,
  normalizeIgnoreKey,
} from "../ignoredExternals.js";
import { matchCensusToFleet } from "../fastExtract.js";
import { resolveDriverId } from "../fuzzy.js";
import { extractImageForKnownCustomer } from "../imageSupport.js";
import { __pushAiExtractStub, __clearAiExtractStubs } from "../aiExtract.js";
import type { RosterContext } from "../aiExtract.js";

// ---------- key derivation ----------

test("ignoreKeysForRow: badge and name-sentinel keys, case/whitespace normalized", () => {
  assert.deepEqual(ignoreKeysForRow("1234", "David Davis"), [
    "1234",
    "name:david davis",
  ]);
  assert.deepEqual(ignoreKeysForRow("  AB12 ", null), ["ab12"]);
  assert.deepEqual(ignoreKeysForRow(null, "  David   Davis "), [
    "name:david davis",
  ]);
  assert.deepEqual(ignoreKeysForRow("", ""), []);
});

test("ignoreClearKeysForPick: a badge pick also clears the name-keyed rule", () => {
  assert.deepEqual(ignoreClearKeysForPick("1234", "David Davis"), [
    "1234",
    "name:david davis",
  ]);
  // A name-sentinel pick clears exactly itself (no duplicate key).
  assert.deepEqual(ignoreClearKeysForPick("name:David Davis", null), [
    "name:david davis",
  ]);
  assert.equal(normalizeIgnoreKey("Name:  DAVID  Davis"), "name: david davis");
});

test("isIgnoredRow: matches either key; empty/absent set never matches", () => {
  const set = new Set(["name:david davis"]);
  assert.equal(isIgnoredRow(set, "9999", "David Davis"), true);
  assert.equal(isIgnoredRow(set, "9999", "Someone Else"), false);
  assert.equal(isIgnoredRow(null, "9999", "David Davis"), false);
  assert.equal(isIgnoredRow(new Set(), "9999", "David Davis"), false);
});

// ---------- matchCensusToFleet veto (the Davis fixture) ----------

// Navarro carries BOTH a global badge alias (1234) and a saved name alias
// ("david davis") pointing at him — the exact contradiction from the
// incident. The ignore veto must beat both lanes.
function davisRoster(over: Partial<RosterContext> = {}): RosterContext {
  return {
    customer: "LSI",
    drivers: [
      {
        kfiId: "K200",
        name: "David Navarro",
        badges: ["1234"],
        aliases: ["david davis"],
        customer: "Shuster's",
      },
      {
        kfiId: "K300",
        name: "Gage Moody",
        badges: [],
        aliases: [],
        customer: "Shuster's",
      },
    ],
    ...over,
  };
}

test("badge-keyed ignore beats the pinned-badge alias lane", () => {
  const { targets, strangers, laneCounts, ignoredWorkers } = matchCensusToFleet(
    [{ name: "David Davis", badge: "1234" }],
    davisRoster({ ignoredExternalIds: ["1234"] }),
  );
  assert.equal(targets.length, 0);
  assert.equal(laneCounts.ignoredBlocked, 1);
  assert.equal(laneCounts.badge, 0);
  assert.match(strangers[0], /not a driver/);
  assert.deepEqual(ignoredWorkers, [{ name: "David Davis", badge: "1234" }]);
});

test("name-keyed ignore beats the saved name-alias lane", () => {
  const { targets, laneCounts } = matchCensusToFleet(
    [{ name: "David Davis", badge: null }],
    davisRoster({ ignoredExternalIds: [NAME_KEY_PREFIX + "david davis"] }),
  );
  assert.equal(targets.length, 0);
  assert.equal(laneCounts.ignoredBlocked, 1);
  assert.equal(laneCounts.nameAlias, 0);
});

test("control: without the ignore rule the alias still resolves", () => {
  const { targets, laneCounts } = matchCensusToFleet(
    [{ name: "David Davis", badge: "1234" }],
    davisRoster(),
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kfiId, "K200");
  assert.equal(laneCounts.badge, 1);
  assert.equal(laneCounts.ignoredBlocked, 0);
});

test("ignore veto fires before (and instead of) the zero-CT block", () => {
  const { laneCounts, strangers } = matchCensusToFleet(
    [{ name: "David Davis", badge: "1234" }],
    davisRoster({
      ignoredExternalIds: ["1234"],
      ctActiveKfiIds: [], // nobody has CT time — zero-CT would also block
    }),
  );
  assert.equal(laneCounts.ignoredBlocked, 1);
  assert.equal(laneCounts.zeroCtBlocked, 0);
  assert.match(strangers[0], /not a driver/);
});

test("non-ignored coworker in the same census resolves normally", () => {
  const { targets, laneCounts } = matchCensusToFleet(
    [
      { name: "David Davis", badge: "1234" },
      { name: "Gage Moody", badge: null },
    ],
    davisRoster({ ignoredExternalIds: ["1234"] }),
  );
  assert.equal(laneCounts.ignoredBlocked, 1);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kfiId, "K300");
});

test("fuzzy-assignable ignored worker is blocked, not sent to the picker", () => {
  // "Moody, Gage" would auto-assign to Gage Moody by full-coverage fuzzy —
  // the name-keyed ignore must stop it before the fuzzy lane runs.
  const { targets, laneCounts } = matchCensusToFleet(
    [{ name: "Moody, Gage", badge: null }],
    davisRoster({ ignoredExternalIds: [NAME_KEY_PREFIX + "moody, gage"] }),
  );
  assert.equal(targets.length, 0);
  assert.equal(laneCounts.ignoredBlocked, 1);
  assert.equal(laneCounts.fuzzyConfident, 0);
  assert.equal(laneCounts.fuzzyBorderline, 0);
});

test("no-roster early branch still applies the veto", () => {
  const { targets, laneCounts, ignoredWorkers } = matchCensusToFleet(
    [
      { name: "David Davis", badge: "1234" },
      { name: "Gage Moody", badge: null },
    ],
    { customer: "LSI", drivers: [], ignoredExternalIds: ["1234"] },
  );
  assert.equal(laneCounts.ignoredBlocked, 1);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "Gage Moody");
  assert.equal(ignoredWorkers.length, 1);
});

// ---------- resolveDriverId veto ----------

test("resolveDriverId: ignore veto beats the authoritative badge alias", () => {
  const ctx = {
    idMap: { "1234": "K200" },
    fuzzyPool: [{ kfiId: "K200", name: "David Navarro" }],
    kfiSet: new Set(["K200"]),
    nameAliasMap: new Map([["david davis", "K200"]]),
    uploadedCustomer: "LSI",
    driversByKfi: new Map([
      ["K200", { name: "David Navarro", customer: "Shuster's" }],
    ]),
  };
  // Without the veto both lanes resolve.
  assert.equal(
    resolveDriverId({ badge: "1234", nameOnDoc: "David Davis" }, ctx),
    "K200",
  );
  // Badge-keyed and name-keyed vetoes both return null.
  assert.equal(
    resolveDriverId(
      { badge: "1234", nameOnDoc: "David Davis" },
      { ...ctx, ignoredExternalIds: new Set(["1234"]) },
    ),
    null,
  );
  assert.equal(
    resolveDriverId(
      { badge: "", nameOnDoc: "David Davis" },
      { ...ctx, ignoredExternalIds: new Set(["name:david davis"]) },
    ),
    null,
  );
});

// ---------- row-loop veto in extractImageForKnownCustomer ----------

const STASHED_BYTES = Buffer.from(
  "%PDF-1.4 ignored-externals-fixture\n%%EOF\n",
  "utf8",
);
const drivers = [
  { kfiId: "K200", name: "David Navarro", customer: "Shuster's" },
  { kfiId: "K300", name: "Gage Moody", customer: "Shuster's" },
];
const kfiSet = new Set(drivers.map((d) => d.kfiId));

test("vetoed rows land in droppedRows, never in punches/pending/unmapped", async () => {
  const prevFast = process.env.FAST_IMPORT;
  process.env.FAST_IMPORT = "0"; // legacy lane: consumes the stub, no model call
  try {
    __clearAiExtractStubs();
    __pushAiExtractStub([
      {
        driverNameOnDoc: "David Davis",
        badgeOrId: "1234",
        date: "2026-08-28",
        timeIn: "07:31",
        timeOut: "17:25",
      },
      {
        driverNameOnDoc: "Gage Moody",
        date: "2026-08-28",
        timeIn: "07:00",
        timeOut: "15:00",
        resolvedKfiId: "K300",
      },
    ] as never);
    const result = await extractImageForKnownCustomer({
      fileName: "LSI weekly.pdf",
      buffer: STASHED_BYTES,
      mimeType: "application/octet-stream",
      customer: "LSI",
      weekStart: "2026-08-23",
      weekEnd: "2026-08-29",
      idMap: { "1234": "K200" },
      drivers,
      kfiSet,
      ignoredExternalIds: new Set(["1234"]),
    });
    assert.equal(result.punches.filter((p) => p.kfiId === "K200").length, 0);
    assert.equal(result.pendingNamedRows?.length ?? 0, 0);
    assert.equal(result.unmappedIds.length, 0);
    const vetoed = (result.droppedRows ?? []).filter(
      (d) => d.reason === "not_a_driver_alias",
    );
    assert.equal(vetoed.length, 1);
    assert.equal(vetoed[0].rawRow?.driverNameOnDoc, "David Davis");
    // The coworker's row still lands.
    assert.equal(result.punches.filter((p) => p.kfiId === "K300").length, 1);
  } finally {
    if (prevFast === undefined) delete process.env.FAST_IMPORT;
    else process.env.FAST_IMPORT = prevFast;
    __clearAiExtractStubs();
  }
});

test("name-keyed veto blocks a row with no badge", async () => {
  const prevFast = process.env.FAST_IMPORT;
  process.env.FAST_IMPORT = "0";
  try {
    __clearAiExtractStubs();
    __pushAiExtractStub([
      {
        driverNameOnDoc: "David Davis",
        date: "2026-08-28",
        timeIn: "09:00",
        timeOut: "11:30",
      },
    ] as never);
    const result = await extractImageForKnownCustomer({
      fileName: "LSI weekly.pdf",
      buffer: STASHED_BYTES,
      mimeType: "application/octet-stream",
      customer: "LSI",
      weekStart: "2026-08-23",
      weekEnd: "2026-08-29",
      idMap: {},
      drivers,
      kfiSet,
      nameAliasMap: new Map([["david davis", "K200"]]),
      ignoredExternalIds: new Set(["name:david davis"]),
    });
    assert.equal(result.punches.length, 0);
    assert.equal(result.pendingNamedRows?.length ?? 0, 0);
    assert.equal(result.unmappedIds.length, 0);
    const vetoed = (result.droppedRows ?? []).filter(
      (d) => d.reason === "not_a_driver_alias",
    );
    assert.equal(vetoed.length, 1);
  } finally {
    if (prevFast === undefined) delete process.env.FAST_IMPORT;
    else process.env.FAST_IMPORT = prevFast;
    __clearAiExtractStubs();
  }
});
