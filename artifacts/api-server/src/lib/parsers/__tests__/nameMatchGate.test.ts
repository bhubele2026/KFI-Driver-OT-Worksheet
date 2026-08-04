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
