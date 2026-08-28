import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractNoHours, noHoursEmailList, removeNoHoursPeople, planDriverRemoval,
  checkDriverAdjustmentsTie, assertMasterHeaders, MASTER_HEADERS,
  EXPECTED_UNMATCHED_DRIVER_IDS, type MasterRow,
} from "../payrollMasterImport";

const row = (o: Partial<MasterRow>): MasterRow => ({
  customer: "Penda Corp", person: "Doe, Jane", personId: 1,
  transactionCode: "RT", payUnit: 40, billUnit: 40, ...o,
});

describe("no-hours extraction", () => {
  it("treats a BLANK and a 0 pay unit identically", () => {
    // Both mean the person reported nothing; the filter in the spreadsheet
    // selects "Blanks AND 0" for exactly this reason.
    const people = extractNoHours([
      row({ personId: 1, payUnit: null }),
      row({ personId: 2, payUnit: 0 }),
      row({ personId: 3, payUnit: 40 }),
    ]);
    assert.deepEqual(people.map((p) => p.personId).sort(), [1, 2]);
  });

  it("keys off the RT row, since a fringe row is not worked hours", () => {
    const people = extractNoHours([
      row({ personId: 9, transactionCode: "Housing Benefit Supplemental", payUnit: 1 }),
      row({ personId: 9, transactionCode: "RT", payUnit: 0 }),
    ]);
    assert.equal(people.length, 1);
  });

  it("does not list the same person twice", () => {
    const people = extractNoHours([
      row({ personId: 5, payUnit: 0 }), row({ personId: 5, payUnit: 0 }),
    ]);
    assert.equal(people.length, 1);
  });
});

describe("the Operations email", () => {
  it("EXCLUDES Martin, who is not billable", () => {
    // Asking Operations about Martin every week is noise — he is expected to
    // have no customer hours.
    const people = extractNoHours([
      row({ personId: 2003940, person: "Ramirez Cruz, Martin", payUnit: 0 }),
      row({ personId: 7, person: "Real, Person", payUnit: 0 }),
    ]);
    const email = noHoursEmailList(people);
    assert.equal(email.length, 1);
    assert.equal(email[0]!.personId, 7);
  });

  it("still removes Martin from the FILE — he is only off the email", () => {
    const rows = [
      row({ personId: 2003940, payUnit: 0 }),
      row({ personId: 2003940, transactionCode: "OT", payUnit: 2 }),
      row({ personId: 7, payUnit: 40 }),
    ];
    const { rows: kept } = removeNoHoursPeople(rows, extractNoHours(rows));
    assert.deepEqual(kept.map((r) => r.personId), [7]);
  });

  it("says WHY someone was left off, rather than dropping them silently", () => {
    const people = extractNoHours([row({ personId: 2003940, payUnit: 0 })]);
    assert.match(String(people[0]!.excludeReason), /not billable/);
  });
});

describe("removing no-hours people", () => {
  it("removes EVERY row for the person, not just the RT one", () => {
    // Leaving the OT row behind pays overtime to someone who reported no
    // regular hours at all.
    const rows = [
      row({ personId: 3, transactionCode: "RT", payUnit: 0 }),
      row({ personId: 3, transactionCode: "OT", payUnit: 4 }),
      row({ personId: 4, transactionCode: "RT", payUnit: 40 }),
    ];
    const out = removeNoHoursPeople(rows, extractNoHours(rows));
    assert.equal(out.removed, 2);
    assert.deepEqual(out.rows.map((r) => r.personId), [4]);
  });
});

describe("driver removal plan", () => {
  const master = [
    row({ personId: 100, customer: "Penda Corp", transactionCode: "RT", payUnit: 32 }),
    row({ personId: 100, customer: "Penda Corp", transactionCode: "OT", payUnit: 6 }),
    row({ personId: 200, customer: "Adient", transactionCode: "RT", payUnit: 40 }),
  ];

  it("matches drivers present on the master and totals their hours per customer", () => {
    const plan = planDriverRemoval(master, [100]);
    assert.deepEqual(plan.matched, [100]);
    assert.deepEqual(plan.adjustments, [{ customer: "Penda Corp", driverRt: 32, driverOt: 6 }]);
    assert.deepEqual(plan.totals, { driverRt: 32, driverOt: 6 });
  });

  it("NAMES the four who legitimately never match, so they are not shrugged at", () => {
    const plan = planDriverRemoval(master, [100, 2004462, 2003940, 2003762, 2004067]);
    assert.equal(plan.expectedUnmatched.length, 4);
    assert.equal(plan.unexpectedUnmatched.length, 0);
    assert.match(plan.expectedUnmatched[0]!.reason, /Zenople|billable/);
  });

  it("SEPARATES an unexpected miss from the four known ones", () => {
    // A shrug at four unexplained misses is how a real fifth one gets missed.
    const plan = planDriverRemoval(master, [2004462, 999999]);
    assert.deepEqual(plan.unexpectedUnmatched, [999999]);
    assert.equal(plan.expectedUnmatched.length, 1);
  });

  it("covers all four documented ids", () => {
    assert.deepEqual([...EXPECTED_UNMATCHED_DRIVER_IDS.keys()].sort((a, b) => a - b),
      [2003762, 2003940, 2004067, 2004462]);
  });

  it("is a PLAN — it does not mutate the master", () => {
    const before = master.length;
    planDriverRemoval(master, [100]);
    assert.equal(master.length, before);
  });
});

describe("driver adjustments must tie to the worksheet", () => {
  const plan = planDriverRemoval(
    [row({ personId: 100, transactionCode: "RT", payUnit: 32 }),
     row({ personId: 100, transactionCode: "OT", payUnit: 6 })], [100]);

  it("passes when both legs agree", () => {
    assert.equal(checkDriverAdjustmentsTie(plan, 32, 6).ok, true);
  });

  it("fails and shows BOTH legs when they do not", () => {
    const r = checkDriverAdjustmentsTie(plan, 30, 6);
    assert.equal(r.ok, false);
    assert.match(r.message, /plan RT 32 vs worksheet 30/);
  });
});

describe("master headers", () => {
  it("keeps the LEADING SPACES Zenople emits", () => {
    // Trimming these produces a file that looks right and will not load.
    assert.equal(MASTER_HEADERS[14], " End Date");
    assert.equal(MASTER_HEADERS[15], " Status");
    assert.equal(MASTER_HEADERS[16], " Assignment Id");
  });

  it("accepts the exact header row", () => {
    assert.doesNotThrow(() => assertMasterHeaders([...MASTER_HEADERS]));
  });

  it("REJECTS a trimmed header row", () => {
    const trimmed = MASTER_HEADERS.map((h) => h.trim());
    assert.throws(() => assertMasterHeaders(trimmed), /leading spaces matter/);
  });
});
