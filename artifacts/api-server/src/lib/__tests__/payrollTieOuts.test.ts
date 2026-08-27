import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tieOutPayVsBillUnits, tieOutOtWithout40, tieOutFringeVsDeductions,
  tieOutRetroFringeVsOffset, tieOutMasterVsBatch, tieOutTaxVsRegister,
  type TxItem,
} from "../payrollTieOuts";

const row = (o: Partial<TxItem>): TxItem => ({
  Organization: "Penda Corp", Person: "Doe, Jane", PersonId: 1,
  TransactionCode: "RT", PayUnit: 40, BillUnit: 40, ItemPay: 0, ItemBill: 0, ...o,
});

describe("tie-out 1 — regular pay hours vs regular bill hours", () => {
  it("passes when they agree", () => {
    const res = tieOutPayVsBillUnits([row({}), row({ PersonId: 2, PayUnit: 8, BillUnit: 8 })]);
    assert.ok(res.every((r) => r.status === "pass"));
  });

  it("FAILS on a mismatched person and names them", () => {
    const res = tieOutPayVsBillUnits([row({ PayUnit: 40, BillUnit: 38 })]);
    const cust = res.find((r) => r.scope === "Penda Corp")!;
    assert.equal(cust.status, "fail");
    assert.equal((cust.detail[0] as { person: string }).person, "Doe, Jane");
    assert.equal((cust.detail[0] as { variance: number }).variance, 2);
  });

  it("aggregates pay and bill across SEPARATE rows for one person", () => {
    // Real shape: Zenople splits the driver's pay side off the bill side.
    const res = tieOutPayVsBillUnits([
      row({ TransactionCode: "RT", PayUnit: 0, BillUnit: 40 }),
      row({ TransactionCode: "RT", PayUnit: 32.37, BillUnit: 0 }),
      row({ TransactionCode: "DriverRT", PayUnit: 7.63, BillUnit: 0 }),
    ]);
    assert.ok(res.every((r) => r.status === "pass"), "40 pay vs 40 bill must tie");
  });

  it("does NOT compare OT — driver overtime is paid but not billed", () => {
    const res = tieOutPayVsBillUnits([
      row({ TransactionCode: "OT", PayUnit: 30.08, BillUnit: 0 }),
      row({ TransactionCode: "DriverOT", PayUnit: 7.9, BillUnit: 0 }),
    ]);
    assert.ok(res.every((r) => r.status === "pass"));
  });

  it("does NOT fail on lump sums, which zero every bill column", () => {
    const res = tieOutPayVsBillUnits([
      row({ TransactionCode: "Housing Benefit Supplemental", PayUnit: 1, BillUnit: 0 }),
      row({ TransactionCode: "MN ESST", PayUnit: 10, BillUnit: 0 }),
    ]);
    assert.ok(res.every((r) => r.status === "pass"));
  });

  it("silences a known non-billable associate without hiding a new one", () => {
    const rows = [
      row({ PersonId: 7, Person: "Doran, Joy", PayUnit: 40, BillUnit: 0 }),
      row({ PersonId: 8, Person: "New, Person", PayUnit: 40, BillUnit: 0 }),
    ];
    const res = tieOutPayVsBillUnits(rows, new Set([7]));
    const cust = res.find((r) => r.scope === "Penda Corp")!;
    assert.equal(cust.detail.length, 1);
    assert.equal((cust.detail[0] as { person: string }).person, "New, Person");
  });
});

describe("tie-out 3 — the 40-hour rules", () => {
  it("passes a clean week", () => {
    assert.equal(tieOutOtWithout40([row({ PayUnit: 40 }), row({ TransactionCode: "OT", PayUnit: 5 })]).status, "pass");
  });

  it("counts DriverRT toward the 40 — a driver split 32.37 + 7.63 is NOT an exception", () => {
    // Every one of the 13 real drivers in AP 2026-08-23 landed on exactly 40.00
    // this way. Judging on RT alone raised 13 false alarms in a single week.
    const res = tieOutOtWithout40([
      row({ TransactionCode: "RT", PayUnit: 32.37 }),
      row({ TransactionCode: "DriverRT", PayUnit: 7.63 }),
      row({ TransactionCode: "OT", PayUnit: 22.57 }),
      row({ TransactionCode: "DriverOT", PayUnit: 5.25 }),
    ]);
    assert.equal(res.status, "pass", "driver base hours must count toward 40");
  });

  it("FAILS a genuine 39-hour person carrying OT", () => {
    const res = tieOutOtWithout40([
      row({ PayUnit: 39 }),
      row({ TransactionCode: "OT", PayUnit: 3 }),
    ]);
    assert.equal(res.status, "fail");
    assert.match((res.detail[0] as { reason: string }).reason, /without 40/);
  });

  it("FAILS anyone over 40 base hours", () => {
    const res = tieOutOtWithout40([row({ PayUnit: 44 })]);
    assert.equal(res.status, "fail");
    assert.match((res.detail[0] as { reason: string }).reason, /over 40/);
  });

  it("aggregates a person across assignments before judging", () => {
    const res = tieOutOtWithout40([
      row({ PayUnit: 20, AssignmentId: 11 }),
      row({ PayUnit: 20, AssignmentId: 12 }),
      row({ TransactionCode: "OT", PayUnit: 4 }),
    ]);
    assert.equal(res.status, "pass");
  });
});

describe("tie-out 4 — fringe must match EXACTLY", () => {
  it("passes on the reference week's real figure", () => {
    const res = tieOutFringeVsDeductions(
      [row({ TransactionCode: "Housing Benefit Supplemental", ItemPay: 722.71 })],
      722.71,
    );
    assert.equal(res.status, "pass");
    assert.equal(res.expected, "722.71");
  });

  it("FAILS on a one-cent difference — this one is not approximate", () => {
    const res = tieOutFringeVsDeductions(
      [row({ TransactionCode: "Housing Benefit Supplemental", ItemPay: 722.71 })],
      722.70,
    );
    assert.equal(res.status, "fail");
    assert.equal(res.variance, "+0.01");
  });

  it("keeps the workbook's sign convention: positive means missing deductions", () => {
    const short = tieOutFringeVsDeductions(
      [row({ TransactionCode: "Housing Benefit Supplemental", ItemPay: 800 })], 700);
    assert.match(String((short.detail[0] as { hint: string }).hint), /missing deductions/);
    const over = tieOutFringeVsDeductions(
      [row({ TransactionCode: "Housing Benefit Supplemental", ItemPay: 700 })], 800);
    assert.match(String((over.detail[0] as { hint: string }).hint), /missing earnings/);
  });

  it("sums in cents so floating point cannot drift it", () => {
    const rows = Array.from({ length: 3 }, () =>
      row({ TransactionCode: "Housing Benefit Supplemental", ItemPay: 0.1 }));
    assert.equal(tieOutFringeVsDeductions(rows, 0.3).status, "pass");
  });
});

describe("tie-out 5 — retro fringe vs offset", () => {
  it("passes when equal and FAILS when not", () => {
    const rows = [row({ TransactionCode: "Retro Housing Benefit Sup", ItemPay: 130 })];
    assert.equal(tieOutRetroFringeVsOffset(rows, 130).status, "pass");
    assert.equal(tieOutRetroFringeVsOffset(rows, 125).status, "fail");
  });
});

describe("tie-out 2 — master vs Zenople batch", () => {
  it("FAILS and names the customer when the master drifts", () => {
    const master = [row({ PayUnit: 40 }), row({ TransactionCode: "OT", PayUnit: 5 })];
    const zen = [row({ PayUnit: 38 }), row({ TransactionCode: "OT", PayUnit: 5 })];
    const res = tieOutMasterVsBatch(master, zen);
    assert.equal(res[0]!.status, "fail");
    assert.equal(res[0]!.scope, "Penda Corp");
    assert.match(res[0]!.variance, /RT 2\.00/);
  });

  it("catches a customer present in one side only", () => {
    const res = tieOutMasterVsBatch([row({ Organization: "Trienda Holdings" })], []);
    assert.equal(res[0]!.status, "fail");
  });
});

describe("tie-out 6 — tax pivot vs register vs APTM", () => {
  it("passes all three legs", () => {
    assert.equal(tieOutTaxVsRegister(100.25, 100.25, 100.25).status, "pass");
  });
  it("FAILS when APTM disagrees even though the pivot ties", () => {
    assert.equal(tieOutTaxVsRegister(100.25, 100.25, 99.0).status, "fail");
  });
  it("still checks pivot vs register before APTM exists", () => {
    assert.equal(tieOutTaxVsRegister(100.25, 100.0, null).status, "fail");
  });
});
