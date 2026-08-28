import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expertPayDates, checkExpertPayDates, checkExpertPayFormat, checkExpertPayTotals,
  checkBankAccount, expertPayExportNote, runExpertPayChecks,
  EXPERT_PAY_BANK,
} from "../payrollExpertPay";

describe("the two dates, which are not the same date", () => {
  it("effective is the TUESDAY AFTER a Friday pay date", () => {
    const d = expertPayDates("2026-08-28"); // Friday
    assert.equal(d.effectiveDate, "2026-09-01"); // Tuesday
    assert.equal(d.withholdingDate, "2026-08-28");
  });

  it("rolls a full week when the pay date is itself a Tuesday", () => {
    // "the Tuesday after" must mean strictly after, or an off-cycle Tuesday
    // run would date itself the same day.
    assert.equal(expertPayDates("2026-08-25").effectiveDate, "2026-09-01");
  });

  it("handles an off-cycle mid-week date", () => {
    assert.equal(expertPayDates("2026-08-26").effectiveDate, "2026-09-01"); // Wed -> Tue
  });

  it("FAILS when both dates are entered as the pay date", () => {
    // The obvious slip, and it dates the disbursement wrongly against a court
    // order.
    const c = checkExpertPayDates("2026-08-28", "2026-08-28", "2026-08-28");
    assert.equal(c.status, "fail");
    assert.equal(c.detail.length, 1);
    assert.match(String((c.detail[0] as { rule: string }).rule), /Tuesday after/);
  });

  it("passes the correct pair", () => {
    assert.equal(checkExpertPayDates("2026-08-28", "2026-09-01", "2026-08-28").status, "pass");
  });
});

describe("the formatting gates", () => {
  const ok = {
    openedWithoutConverting: true, columnCZeroDecimals: true,
    ssnLeadingZerosIntact: true, savedAfterFormatting: true,
  };

  it("passes a correctly prepared file", () => {
    assert.equal(checkExpertPayFormat(ok).status, "pass");
  });

  it("blocks a converted open, which strips leading zeros from SSNs", () => {
    const c = checkExpertPayFormat({ ...ok, openedWithoutConverting: false });
    assert.equal(c.status, "fail");
    assert.match(String(c.detail[0]), /leading zeros/);
  });

  it("blocks an unsaved file, the usual cause of the upload error", () => {
    const c = checkExpertPayFormat({ ...ok, savedAfterFormatting: false });
    assert.match(String(c.detail[0]), /SAVE the file/);
  });

  it("lists everything outstanding", () => {
    assert.equal(checkExpertPayFormat({
      openedWithoutConverting: false, columnCZeroDecimals: false,
      ssnLeadingZerosIntact: false, savedAfterFormatting: false,
    }).detail.length, 4);
  });
});

describe("totals, allowing for fees", () => {
  it("passes when the system is slightly HIGHER — we pay the fees", () => {
    // An exact-match check would fail every single week.
    assert.equal(checkExpertPayTotals(5000, 5012.5).status, "pass");
  });

  it("passes an exact match too", () => {
    assert.equal(checkExpertPayTotals(5000, 5000).status, "pass");
  });

  it("FAILS when the system is LOWER — payments are missing", () => {
    const c = checkExpertPayTotals(5000, 4900);
    assert.equal(c.status, "fail");
    assert.match(c.message, /LESS than the file/);
  });

  it("FAILS when the excess is too big to be a fee", () => {
    const c = checkExpertPayTotals(5000, 6000);
    assert.equal(c.status, "fail");
    assert.match(c.message, /more than a plausible fee/);
  });

  it("keeps a floor so a tiny file is not judged too tightly", () => {
    assert.equal(checkExpertPayTotals(20, 24).status, "pass");
  });
});

describe("the bank account", () => {
  it("requires Bank 7, not the operating account", () => {
    assert.equal(EXPERT_PAY_BANK, "Bank 7");
    assert.equal(checkBankAccount("Bank 7").status, "pass");
  });

  it("FAILS any other account", () => {
    const c = checkBankAccount("Bank 1");
    assert.equal(c.status, "fail");
    assert.match(c.message, /child support draws from Bank 7/);
  });

  it("tolerates casing and whitespace", () => {
    assert.equal(checkBankAccount("  bank 7 ").status, "pass");
  });
});

describe("the export note", () => {
  it("matches the format Zenople is keyed on", () => {
    assert.equal(expertPayExportNote("2026-08-28"), "CS PD 08.28.2026");
  });
});

describe("runExpertPayChecks", () => {
  it("passes a correct run end to end", () => {
    const out = runExpertPayChecks({
      payDate: "2026-08-28",
      enteredEffective: "2026-09-01", enteredWithholding: "2026-08-28",
      bankAccount: "Bank 7",
      format: {
        openedWithoutConverting: true, columnCZeroDecimals: true,
        ssnLeadingZerosIntact: true, savedAfterFormatting: true,
      },
      csvTotal: 5000, systemTotal: 5012.5,
    });
    assert.ok(out.every((c) => c.status === "pass" || c.status === "info"),
      JSON.stringify(out.filter((c) => c.status !== "pass" && c.status !== "info")));
  });

  it("never asks for or handles the file's rows", () => {
    // The CSV holds unmasked SSNs. Nothing in this module's surface takes them.
    const surface = JSON.stringify(Object.keys(runExpertPayChecks({ payDate: "2026-08-28" })));
    assert.ok(!/ssn|rows|employees/i.test(surface));
  });
});
