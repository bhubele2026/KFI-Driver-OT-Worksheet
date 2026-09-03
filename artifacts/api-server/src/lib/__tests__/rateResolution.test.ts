/**
 * resolveProfile — the one answer to "what will this driver export at".
 *
 * The card and the workbook used to disagree because they were two code paths.
 * These tests pin the contract that keeps them the same number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { overriddenRateFields, resolveProfile } from "../rateResolution.js";
import type { ZenopleProfile } from "../zenopleExport.js";

/**
 * Modelled on Baez (2003283) as verified in prod on 2026-09-03: the stored row
 * has been untouched since 2026-05-19, and its BILL rates have since drifted
 * away from Zenople (stored 31.58 / 43.43 vs live 30.70 / 46.05) while the pay
 * rates still agree. `rtPayRate` here is deliberately off by a cent from the
 * live 21.93 so one field exercises the drift path — the pay rates matched in
 * production.
 */
const stored: ZenopleProfile = {
  ssn: "XXX-XX-5416",
  jobId: 559,
  personId: 2003283,
  assignmentId: 2541,
  zenopleCustomer: "Burnett Dairy - Grantsburg",
  rtPayRate: 21.83,
  rtBillRate: 31.58,
  otPayRate: 32.9,
  otBillRate: 43.43,
  driverRtPayRate: 10,
  driverRtBillRate: 0,
  driverOtPayRate: 32.9,
  driverOtBillRate: 0,
};

test("effective rates are what the export ships; stored is returned untouched", () => {
  const live = {
    rtPayRate: 21.93,
    otPayRate: 32.9,
    sources: { rtPayRate: "assignment" as const, otPayRate: "derived" as const },
  };
  const r = resolveProfile(stored, live);
  assert.equal(r.effective.rtPayRate, 21.93); // live wins
  assert.equal(r.stored.rtPayRate, 21.83); // ...and the saved row is preserved verbatim
  // The Edit form seeds from `stored`. If it seeded from `effective`, one Save
  // would freeze today's Zenople rate as a permanent override — PATCH replaces.
  assert.notEqual(r.stored.rtPayRate, r.effective.rtPayRate);
});

test("provenance says who supplied each number", () => {
  const live = {
    rtPayRate: 21.93,
    otPayRate: 32.9,
    sources: { rtPayRate: "assignment" as const, otPayRate: "derived" as const },
  };
  const r = resolveProfile(stored, live);
  assert.equal(r.provenance.rtPayRate, "zenople");
  assert.equal(r.provenance.otPayRate, "derived"); // 1.5 × RT
  assert.equal(r.provenance.driverRtPayRate, "saved"); // Zenople had nothing
});

test("actuals still read as 'zenople' — they came from Zenople either way", () => {
  const r = resolveProfile(stored, {
    rtPayRate: 21.93,
    sources: { rtPayRate: "actuals" as const },
  });
  assert.equal(r.provenance.rtPayRate, "zenople");
});

test("no live facts at all → every rate is the saved one", () => {
  const r = resolveProfile(stored, null);
  assert.deepEqual(r.effective, stored);
  assert.equal(r.provenance.rtPayRate, "saved");
  assert.equal(r.provenance.otPayRate, "saved");
});

test("a rate nobody has is 'missing' — the workbook writes 0 for it", () => {
  const empty: ZenopleProfile = { ...stored, rtPayRate: null, otPayRate: null };
  const r = resolveProfile(empty, null);
  assert.equal(r.provenance.rtPayRate, "missing");
  assert.equal(r.effective.rtPayRate, null);
});

/**
 * The silent no-op: because live wins for rates, editing a rate on the card
 * for anyone who HAS a Zenople assignment changes nothing. The card has to say
 * so rather than accept a "fix" that will never reach the workbook.
 */
test("overriddenRateFields lists saved values that are being ignored", () => {
  const live = {
    rtPayRate: 21.93, // differs from the saved value → saved one is ignored
    otPayRate: 32.9, // equals the saved 32.90 → not worth flagging
    sources: { rtPayRate: "assignment" as const, otPayRate: "derived" as const },
  };
  const overridden = overriddenRateFields(resolveProfile(stored, live));
  assert.deepEqual(overridden, ["rtPayRate"]);
});

test("nothing is 'overridden' when Zenople supplied nothing", () => {
  assert.deepEqual(overriddenRateFields(resolveProfile(stored, null)), []);
});

/** The real production shape on 2026-09-03: bill rates drifted, pay rates agree. */
test("Baez in prod: bill rates are flagged as overridden, pay rates are not", () => {
  const live = {
    rtPayRate: 21.93,
    rtBillRate: 30.7,
    otPayRate: 32.9,
    otBillRate: 46.05,
    sources: {
      rtPayRate: "assignment" as const,
      rtBillRate: "assignment" as const,
      otPayRate: "derived" as const,
      otBillRate: "derived" as const,
    },
  };
  const r = resolveProfile({ ...stored, rtPayRate: 21.93 }, live);
  assert.deepEqual(overriddenRateFields(r), ["rtBillRate", "otBillRate"]);
  assert.equal(r.provenance.rtPayRate, "zenople");
  assert.equal(r.provenance.otPayRate, "derived");
});
