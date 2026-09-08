/**
 * 2026-08-04 matching hardening (Burnett "both Juans" / WB Erica Silverio
 * Reyes / zero-Connecteam rule):
 *  - a bare first name must never auto-claim a driver (last names required),
 *  - partial-surname overlaps (double-surname drivers) go to the PICKER
 *    instead of being discarded as strangers,
 *  - with `ctActiveKfiIds` provided, NO lane may attach a worker to a
 *    driver who has no Connecteam time this week (hard block).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nameMatchQuality,
  isAutoAssignableName,
  resolveDriverId,
} from "../fuzzy.js";
import { matchCensusToFleet } from "../fastExtract.js";
import type { RosterContext } from "../aiExtract.js";

// ---------- nameMatchQuality / isAutoAssignableName ----------

test("bare first name scores 1.0 by average but is NOT auto-assignable", () => {
  const q = nameMatchQuality("Juan", "Juan Disla");
  assert.equal(q.score, 1);
  assert.equal(q.strongPairs, 1);
  assert.equal(q.fullCoverage, false);
  assert.equal(isAutoAssignableName("Juan", "Juan Disla"), false);
});

test("first name + dropped single-letter initial is NOT auto-assignable", () => {
  // normalize() drops 1-char tokens, so "Juan D." reduces to just "juan".
  assert.equal(isAutoAssignableName("Juan D.", "Juan Disla"), false);
});

test("full name in LAST, FIRST order stays auto-assignable (Choncoa regression)", () => {
  assert.equal(isAutoAssignableName("Choncoa, Ashley M", "Ashley Choncoa"), true);
  assert.equal(isAutoAssignableName("VILLARREAL, JESSE", "Jesse Villarreal"), true);
  // Minor spelling drift on a full name still clears the gate.
  assert.equal(isAutoAssignableName("Chavez, Damian", "Damien Chavez"), true);
});

test("partial surname of a double-surname driver is NOT auto-assignable", () => {
  const q = nameMatchQuality("Reyes, Erica", "Erica Silverio Reyes");
  assert.equal(q.strongPairs, 2);
  assert.equal(q.fullCoverage, false);
  assert.equal(isAutoAssignableName("Reyes, Erica", "Erica Silverio Reyes"), false);
});

test("extra second surname on the document still auto-assigns (Lunar case)", () => {
  // Sheet carries both surnames, Connecteam only one — full roster coverage
  // wins even though the averaged score is dragged down by "Molina".
  assert.equal(isAutoAssignableName("Lunar Molina, Aldo", "Aldo Lunar"), true);
});

test("different surname is neither assignable nor strong", () => {
  const q = nameMatchQuality("Juan Mirelez", "Juan Disla");
  assert.equal(q.strongPairs, 1);
  assert.equal(isAutoAssignableName("Juan Mirelez", "Juan Disla"), false);
});

// ---------- matchCensusToFleet ----------

function roster(over: Partial<RosterContext> = {}): RosterContext {
  return {
    customer: "Burnett Dairy - Grantsburg",
    drivers: [
      {
        kfiId: "2005201",
        name: "Juan Disla",
        badges: [],
        aliases: [],
        customer: "IWG - El Paso",
      },
      {
        kfiId: "2005894",
        name: "Juan Cerda",
        badges: [],
        aliases: [],
        customer: "Burnett Dairy - Grantsburg",
      },
      {
        kfiId: "2009999",
        name: "Erica Silverio Reyes",
        badges: [],
        aliases: [],
        customer: "WB Manufacturing",
      },
      {
        kfiId: "2005310",
        name: "Ashley Choncoa",
        badges: [],
        aliases: [],
        customer: "Penda Corp",
      },
    ],
    ...over,
  };
}

test("bare 'Juan' never auto-assigns — extracted for the picker instead", () => {
  const { targets, strangers, laneCounts } = matchCensusToFleet(
    [{ name: "Juan", badge: null }],
    roster(),
  );
  assert.equal(laneCounts.fuzzyConfident, 0);
  assert.equal(laneCounts.fuzzyBorderline, 1);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kfiId, null);
  assert.equal(strangers.length, 0);
});

test("full-name match still auto-assigns", () => {
  const { targets, laneCounts } = matchCensusToFleet(
    [{ name: "Choncoa, Ashley M", badge: null }],
    roster(),
  );
  assert.equal(laneCounts.fuzzyConfident, 1);
  assert.equal(targets[0].kfiId, "2005310");
});

test("partial double-surname (Erica) goes to the picker, not strangers", () => {
  const { targets, strangers, laneCounts } = matchCensusToFleet(
    [{ name: "Reyes, Erica", badge: null }],
    roster(),
  );
  assert.equal(laneCounts.fuzzyBorderline, 1);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kfiId, null);
  assert.equal(strangers.length, 0);
});

test("cross-surname swap (CT has the other surname) still reaches the picker", () => {
  // Roster knows her as "Erica Silverio"; the sheet says "Silverio Reyes, Erica".
  const r = roster({
    drivers: [
      {
        kfiId: "2009999",
        name: "Erica Silverio",
        badges: [],
        aliases: [],
        customer: "WB Manufacturing",
      },
    ],
  });
  const { targets, laneCounts } = matchCensusToFleet(
    [{ name: "Silverio Reyes, Erica", badge: null }],
    r,
  );
  assert.equal(laneCounts.fuzzyConfident + laneCounts.fuzzyBorderline, 1);
  assert.equal(targets.length, 1);
});

test("census: extra second surname auto-imports (Lunar case)", () => {
  const r = roster({
    drivers: [
      {
        kfiId: "2005940",
        name: "Aldo Lunar",
        badges: [],
        aliases: [],
        customer: "Shuster's Building Components",
      },
    ],
  });
  const { targets, laneCounts } = matchCensusToFleet(
    [{ name: "Lunar Molina, Aldo", badge: "3404" }],
    r,
  );
  assert.equal(laneCounts.fuzzyConfident, 1);
  assert.equal(targets[0].kfiId, "2005940");
});

test("true stranger (different surname) stays a stranger", () => {
  const { targets, strangers } = matchCensusToFleet(
    [{ name: "Sanchez, Maria", badge: null }],
    roster(),
  );
  assert.equal(targets.length, 0);
  assert.equal(strangers.length, 1);
});

test("zero-CT hard block: pinned badge to a no-CT driver is blocked with a reason", () => {
  const r = roster({ ctActiveKfiIds: ["2005894"] });
  r.drivers[0].badges = ["10747"]; // the bad Burnett alias shape
  const { targets, strangers, laneCounts } = matchCensusToFleet(
    [{ name: "Mirelez, Juan", badge: "10747" }],
    r,
  );
  assert.equal(laneCounts.zeroCtBlocked, 1);
  assert.equal(targets.length, 0);
  assert.equal(strangers.length, 1);
  assert.match(strangers[0], /no Connecteam time/);
});

test("zero-CT hard block: exact-name match to a no-CT driver is blocked", () => {
  const r = roster({ ctActiveKfiIds: ["2005201"] }); // Choncoa NOT active
  const { targets, strangers, laneCounts } = matchCensusToFleet(
    [{ name: "Choncoa, Ashley M", badge: null }],
    r,
  );
  assert.equal(laneCounts.zeroCtBlocked, 1);
  assert.equal(targets.length, 0);
  assert.match(strangers[0], /no Connecteam time/);
});

test("zero-CT set present: CT-active exact match still imports", () => {
  const r = roster({ ctActiveKfiIds: ["2005310"] });
  const { targets, laneCounts } = matchCensusToFleet(
    [{ name: "Choncoa, Ashley M", badge: null }],
    r,
  );
  assert.equal(laneCounts.zeroCtBlocked, 0);
  assert.equal(targets[0].kfiId, "2005310");
});

// ---------- resolveDriverId (shared row-level lane) ----------

test("resolveDriverId: bare first name no longer resolves", () => {
  const ctx = {
    idMap: {},
    fuzzyPool: [{ kfiId: "2005201", name: "Juan Disla" }],
    kfiSet: new Set(["2005201"]),
    uploadedCustomer: "Burnett Dairy - Grantsburg",
    driversByKfi: new Map([
      ["2005201", { name: "Juan Disla", customer: "IWG - El Paso" }],
    ]),
  };
  assert.equal(resolveDriverId({ badge: "", nameOnDoc: "Juan" }, ctx), null);
  assert.equal(
    resolveDriverId({ badge: "", nameOnDoc: "Disla, Juan" }, ctx),
    "2005201",
  );
});

// ---------- 2026-09-08: Burnett's preferred names (Willie "Anthony" Medina) ----------
//
// Burnett Grantsburg's punch export carries `Last Name` + `Preferred/First
// Name`. Column E is the NICKNAME, so the sheet says "Medina, Anthony" while
// the roster — built from Connecteam firstName + lastName — says "Willie
// Medina". Tiana reported both of these as "didn't come in" on PD 09.11.2026.

function burnettRoster(over: Partial<RosterContext> = {}): RosterContext {
  return {
    customer: "Burnett Dairy - Grantsburg",
    drivers: [
      {
        kfiId: "2004792",
        name: "Willie Medina",
        badges: [],
        aliases: [],
        customer: "Burnett Dairy - Grantsburg",
      },
      {
        kfiId: "2005128",
        // The same file really does contain an Anthony. Any nickname-tolerant
        // scoring would hand Willie's hours to this man first.
        name: "Anthony Evans",
        badges: [],
        aliases: [],
        customer: "Burnett Dairy - Grantsburg",
      },
      {
        kfiId: "2003301",
        name: "Luis Ceballos Martinez",
        badges: [],
        aliases: [],
        customer: "Burnett Dairy - Grantsburg",
      },
    ],
    ...over,
  };
}

test("preferred-name mismatch scores BELOW the wrong driver (why we don't loosen the gate)", () => {
  const toWillie = nameMatchQuality("Anthony Medina", "Willie Medina");
  const toEvans = nameMatchQuality("Anthony Medina", "Anthony Evans");
  assert.equal(toWillie.strongPairs, 1);
  assert.equal(toEvans.strongPairs, 1);
  // The correct answer scores LOWER than the wrong one. Any threshold loose
  // enough to auto-claim Willie claims Anthony Evans first.
  assert.ok(
    toEvans.score > toWillie.score,
    `expected Evans (${toEvans.score}) > Willie (${toWillie.score})`,
  );
  assert.equal(isAutoAssignableName("Anthony Medina", "Willie Medina"), false);
  assert.equal(isAutoAssignableName("Anthony Medina", "Anthony Evans"), false);
});

test("a shared surname reaches the PICKER instead of being dropped silently", () => {
  const out = matchCensusToFleet(
    [{ name: "Anthony Medina", badge: "10658" }],
    burnettRoster(),
  );
  // Before 2026-09-08 this landed in `strangers`: never extracted, absent from
  // rows, unmappedIds and droppedRows alike — a whole week of pay with no
  // trace anywhere in the UI.
  assert.deepEqual(out.strangers, []);
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].kfiId, null, "must NOT auto-assign");
  assert.equal(out.targets[0].badge, "10658");
  assert.equal(out.laneCounts.surnameNearMiss, 1);
});

test("a pinned badge beats a name the matcher cannot resolve", () => {
  const out = matchCensusToFleet(
    [{ name: "Anthony Medina", badge: "10658" }],
    burnettRoster({
      drivers: burnettRoster().drivers.map((d) =>
        d.kfiId === "2004792" ? { ...d, badges: ["10658"] } : d,
      ),
    }),
  );
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].kfiId, "2004792");
  assert.equal(out.laneCounts.badge, 1);
  assert.equal(out.laneCounts.surnameNearMiss, 0);
});

test("a saved name alias resolves the preferred spelling outright", () => {
  const out = matchCensusToFleet(
    [{ name: "Anthony Medina", badge: null }],
    burnettRoster({
      drivers: burnettRoster().drivers.map((d) =>
        d.kfiId === "2004792" ? { ...d, aliases: ["Anthony Medina"] } : d,
      ),
    }),
  );
  assert.equal(out.targets[0].kfiId, "2004792");
  assert.equal(out.laneCounts.nameAlias, 1);
});

test("a two-surname name still auto-assigns; the surname cell ALONE does not", () => {
  const whole = matchCensusToFleet(
    [{ name: "Luis Ceballos Martinez", badge: "10542" }],
    burnettRoster(),
  );
  assert.equal(whole.targets[0].kfiId, "2003301", "full name auto-assigns");

  // What a census blind to `nameMode: splitLastFirst` can return instead.
  const surnameOnly = matchCensusToFleet(
    [{ name: "Ceballos Martinez", badge: "10542" }],
    burnettRoster(),
  );
  assert.equal(surnameOnly.targets.length, 1);
  assert.equal(surnameOnly.targets[0].kfiId, null);
  assert.deepEqual(surnameOnly.strangers, [], "must reach the picker, not vanish");
});

test("a genuinely unrelated worker is still a stranger", () => {
  const out = matchCensusToFleet(
    [{ name: "Priyanka Raghunathan", badge: "88881" }],
    burnettRoster(),
  );
  assert.equal(out.targets.length, 0);
  assert.equal(out.strangers.length, 1);
  assert.equal(out.laneCounts.surnameNearMiss, 0);
});

test("the ignore veto still beats a surname near-miss (no weekly re-prompt)", () => {
  const out = matchCensusToFleet(
    [{ name: "Anthony Medina", badge: "10658" }],
    burnettRoster({ ignoredExternalIds: ["10658"] }),
  );
  assert.equal(out.targets.length, 0);
  assert.equal(out.laneCounts.ignoredBlocked, 1);
  assert.equal(out.laneCounts.surnameNearMiss, 0);
});
