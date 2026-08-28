import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aptmDeadline, checkBlankTaxCode, checkPivotToRegister, checkCsvPrep,
  aptmFileStatus, runAptmChecks, APTM_DEADLINE_HOUR_CT, APTM_OFFICES,
} from "../payrollAptm";

describe("the 4PM Central cutoff", () => {
  it("is 16:00 CT", () => {
    assert.equal(APTM_DEADLINE_HOUR_CT, 16);
  });

  it("reads the clock in CENTRAL, not the server's timezone", () => {
    // 20:00 UTC is 15:00 CDT — an hour left, not none. A server in UTC reading
    // its own clock would call this past the cutoff and be wrong.
    const d = aptmDeadline(new Date("2026-08-27T20:00:00Z"));
    assert.equal(d.state, "soon");
    assert.equal(d.minutesRemaining, 60);
  });

  it("warns inside the last hour", () => {
    assert.equal(aptmDeadline(new Date("2026-08-27T20:30:00Z")).state, "soon");
  });

  it("says plainly when the cutoff has passed", () => {
    const d = aptmDeadline(new Date("2026-08-27T22:00:00Z")); // 17:00 CDT
    assert.equal(d.state, "past");
    assert.ok(d.minutesRemaining < 0);
  });

  it("is calm in the morning", () => {
    assert.equal(aptmDeadline(new Date("2026-08-27T14:00:00Z")).state, "ok");
  });
});

describe("the blank tax-code line", () => {
  it("ACCEPTS a blank line carrying zero — that is Yvon Agustin", () => {
    // WI resident, KY code not taxable. Uploading with it blank has never
    // errored, and the pivot legitimately shows 0 and 0.
    const c = checkBlankTaxCode([
      { taxCode: "WI", taxableWages: 1000, tax: 50 },
      { taxCode: "", taxableWages: 0, tax: 0 },
    ]);
    assert.equal(c.status, "pass");
  });

  it("FAILS a blank line carrying an amount — something is uncoded", () => {
    const c = checkBlankTaxCode([{ taxCode: null, taxableWages: 900, tax: 40 }]);
    assert.equal(c.status, "fail");
    assert.match(c.message, /uncoded/);
  });

  it("checks the VALUE, not the presence of the line", () => {
    assert.equal(checkBlankTaxCode([{ taxCode: "WI", taxableWages: 1, tax: 1 }]).status, "pass");
  });
});

describe("pivot to register", () => {
  const lines = [
    { taxCode: "FED", taxableWages: 10000, tax: 1200 },
    { taxCode: "WI", taxableWages: 10000, tax: 400 },
  ];

  it("ties against employer PLUS employee tax", () => {
    const c = checkPivotToRegister(lines, { employeeTax: 1000, employerTax: 600 }, "KFIS");
    assert.equal(c.status, "pass");
  });

  it("FAILS against either half alone, and says why", () => {
    // Comparing to just the employee side is the easy mistake.
    const c = checkPivotToRegister(lines, { employeeTax: 1600, employerTax: 0 }, "KFIS");
    assert.equal(c.status, "pass", "1600 + 0 still sums to 1600");
    const bad = checkPivotToRegister(lines, { employeeTax: 1000, employerTax: 0 }, "KFIS");
    assert.equal(bad.status, "fail");
    assert.match(String((bad.detail[0] as { hint: string }).hint), /employer PLUS employee/);
  });

  it("also compares taxable wages when the register supplies them", () => {
    const c = checkPivotToRegister(lines,
      { employeeTax: 1000, employerTax: 600, taxableWages: 19000 }, "KFIS");
    assert.equal(c.status, "fail");
  });

  it("names the office, because the two are uploaded separately", () => {
    assert.deepEqual([...APTM_OFFICES], ["KFIS", "KFISCO"]);
    const c = checkPivotToRegister(lines, { employeeTax: 1000, employerTax: 600 }, "KFISCO");
    assert.match(c.message, /KFISCO/);
  });
});

describe("CSV preparation", () => {
  const ready = {
    headerRowRemoved: true, footerBlankRowRemoved: true,
    savedAsCsv: true, fileClosed: true,
  };

  it("passes a prepared file", () => {
    assert.equal(checkCsvPrep(ready).status, "pass");
  });

  it("blocks on the header row, which APTM errors on", () => {
    const c = checkCsvPrep({ ...ready, headerRowRemoved: false });
    assert.equal(c.status, "fail");
    assert.match(String(c.detail[0]), /header row/);
  });

  it("blocks on an OPEN file — the least obvious of the three", () => {
    const c = checkCsvPrep({ ...ready, fileClosed: false });
    assert.equal(c.status, "fail");
    assert.match(String(c.detail[0]), /CLOSE the file/);
  });

  it("lists everything outstanding, not just the first", () => {
    assert.equal(checkCsvPrep({
      headerRowRemoved: false, footerBlankRowRemoved: false,
      savedAsCsv: false, fileClosed: false,
    }).detail.length, 4);
  });
});

describe("the money safety rule", () => {
  it("allows Valid only when every post-import check is done", () => {
    const c = aptmFileStatus({
      totalMatchesRegister: true, eachTaxAmountTicked: true, qtdMatchesDailyTax: true,
    });
    assert.equal(c.status, "pass");
    assert.match(c.message, /may be left Valid/);
  });

  it("REQUIRES Check status when the review is incomplete", () => {
    // "this will prevent APTM from pulling funds until you have reviewed"
    const c = aptmFileStatus({
      totalMatchesRegister: true, eachTaxAmountTicked: false, qtdMatchesDailyTax: true,
    });
    assert.equal(c.status, "warn");
    assert.match(c.message, /set the file status to Check/);
    assert.equal((c.detail[0] as { requiredStatus: string }).requiredStatus, "Check");
  });

  it("treats no review at all as needing Check", () => {
    assert.equal(aptmFileStatus({
      totalMatchesRegister: false, eachTaxAmountTicked: false, qtdMatchesDailyTax: false,
    }).status, "warn");
  });
});

describe("runAptmChecks", () => {
  it("leads with the clock", () => {
    const out = runAptmChecks({
      office: "KFIS",
      lines: [{ taxCode: "FED", taxableWages: 100, tax: 10 }],
      register: { employeeTax: 10, employerTax: 0 },
      now: new Date("2026-08-27T14:00:00Z"),
    });
    assert.equal(out[0]!.check, "deadline");
    assert.ok(out.every((c) => c.status !== "fail"));
  });
});
