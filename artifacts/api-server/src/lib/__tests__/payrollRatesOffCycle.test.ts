import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkMarkupPropagation, checkTransactionUpdates, checkRateComments,
  checkTerminations, proRateStopsToCarry, checkOldMarkupsDeactivated,
  keepsTimeInZenople, ZENOPLE_TIMEKEEPING_CUSTOMERS,
  type MarkupChange, type Termination,
} from "../payrollRates";
import {
  checkOffCycleArtifacts, checkAdvancePayback, checkVoidReissuePaired,
  checkDeactivatedCards, channelFromFilename, CHANNELS_WITHOUT_BANK_FILE,
  type OffCycleRun,
} from "../payrollOffCycle";

const mc = (o: Partial<MarkupChange> = {}): MarkupChange => ({
  personId: 1, person: "Doe, Jane", customer: "Penda Corp", assignmentId: 11,
  from: "Year1", to: "Year2", effectiveDate: "2026-08-24",
  assignmentUpdated: true, transactionsUpdated: true, commentLogged: true, ...o,
});

describe("the markup propagation trap", () => {
  it("FAILS a change where the assignment was never individually opened", () => {
    // Zenople reports success without propagating. The work instruction proves
    // it with Ricky's assignment.
    const c = checkMarkupPropagation([mc({ assignmentUpdated: false })]);
    assert.equal(c.status, "fail");
    assert.match(c.message, /reports success without propagating/);
  });

  it("passes once every assignment has been opened", () => {
    assert.equal(checkMarkupPropagation([mc(), mc({ personId: 2 })]).status, "pass");
  });
});

describe("Zenople-timekeeping customers need one more step", () => {
  it("seeds the SOP's list, plus the second Bell entity", () => {
    // The SOP says "Alamco, Bell Lumber and Shusters", but the file tree holds
    // BOTH "Bell Lumber" and "Bell Timber" batch reports. Which one keeps time
    // in Zenople is unresolved, so both seed the list — a false positive here
    // costs a redundant check, a false negative skips a required step.
    assert.equal(ZENOPLE_TIMEKEEPING_CUSTOMERS.size, 4);
    assert.ok(ZENOPLE_TIMEKEEPING_CUSTOMERS.has("Shuster's Building Components"));
  });

  it("matches despite the name drift that would break an exact lookup", () => {
    // Zenople says "Shuster's Building Components"; the ledger says "Shusters".
    // An exact-match miss does not error, it silently skips a step that has to
    // happen for the rate change to take effect.
    assert.equal(keepsTimeInZenople("Shuster's Building Components"), true);
    assert.equal(keepsTimeInZenople("Shusters"), true);
    assert.equal(keepsTimeInZenople("shusters"), true);
    assert.equal(keepsTimeInZenople("Alamco Wood Products Inc"), true);
    assert.equal(keepsTimeInZenople("Alamco"), true);
    assert.equal(keepsTimeInZenople("Bell Timber"), true);
    assert.equal(keepsTimeInZenople("Bell Lumber"), true);
  });

  it("does NOT over-match an unrelated customer", () => {
    for (const c of ["Penda Corp", "Trienda Holdings", "Adient", "DeLallo Foods",
                     "Schuette Metals", "Landscape Structures", ""]) {
      assert.equal(keepsTimeInZenople(c), false, c);
    }
  });

  it("FAILS a Shusters change without update-transactions", () => {
    const c = checkTransactionUpdates([
      mc({ customer: "Shuster's Building Components", transactionsUpdated: false })]);
    assert.equal(c.status, "fail");
    assert.match(String((c.detail[0] as { step: string }).step), /yellow star/);
  });

  it("does NOT demand it of an ordinary customer", () => {
    const c = checkTransactionUpdates([mc({ customer: "Penda Corp", transactionsUpdated: false })]);
    assert.equal(c.status, "pass");
  });
});

describe("rate comments", () => {
  it("warns when missing, since the pay history is built from them", () => {
    const c = checkRateComments([mc({ commentLogged: false })]);
    assert.equal(c.status, "warn");
    assert.match(String((c.detail[0] as { suggested: string }).suggested), /Year2/);
  });
});

describe("terminations", () => {
  const t = (o: Partial<Termination> = {}): Termination => ({
    personId: 5, person: "Roe, Sam", customer: "DeLallo Foods",
    lastDayWorked: "2026-08-22", assignmentEnded: true,
    deductionsDeactivated: true, ...o,
  });

  it("FAILS when deductions are still live — they keep charging rent", () => {
    const [, ded] = checkTerminations([t({ deductionsDeactivated: false })]);
    assert.equal(ded!.status, "fail");
    assert.match(ded!.message, /charged rent after leaving/);
  });

  it("checks the assignment end SEPARATELY from the deductions", () => {
    const [assign, ded] = checkTerminations([t({ assignmentEnded: false })]);
    assert.equal(assign!.status, "fail");
    assert.equal(ded!.status, "pass");
  });

  it("carries a pro-rated stop to next period", () => {
    const c = proRateStopsToCarry([t({ hasProRateOnThisCheck: true })]);
    assert.equal(c.status, "info");
    assert.equal(c.detail.length, 1);
  });
});

describe("old markups", () => {
  it("warns while a superseded tier is still active", () => {
    const c = checkOldMarkupsDeactivated("Penda Corp", ["Year1", "Year2"], "Year2");
    assert.equal(c.status, "warn");
    assert.match(c.message, /Year1/);
  });
  it("passes when only the current tier is live", () => {
    assert.equal(checkOldMarkupsDeactivated("Penda Corp", ["Year2"], "Year2").status, "pass");
  });
});

describe("off-cycle artifacts", () => {
  const run = (o: Partial<OffCycleRun> = {}): OffCycleRun => ({
    payDate: "2026-08-26", kind: "advance", channel: "ach",
    people: ["Silva, Aaron"], hasApprovalDocument: true,
    hasTransactionBatchReport: true, hasPaymentBatchReport: true,
    hasBankFile: true, paybackScheduled: true, ...o,
  });

  it("passes a complete ACH run", () => {
    assert.equal(checkOffCycleArtifacts(run()).status, "pass");
  });

  it("FAILS an ACH run with no bank file — that is genuinely wrong", () => {
    const c = checkOffCycleArtifacts(run({ hasBankFile: false }));
    assert.equal(c.status, "fail");
    assert.match(String(c.detail[0]), /expected for ACH/);
  });

  it("ACCEPTS a Walmart card run with no bank file, given a recorded reason", () => {
    // "WALMART cards sent electronically this bank feed was not processed
    // through our bank" — normal, and must be stated rather than inferred.
    const c = checkOffCycleArtifacts(run({
      channel: "walmart_ecard", hasBankFile: false,
      noBankFileReason: "cards sent electronically, not through our bank",
    }));
    assert.equal(c.status, "pass");
  });

  it("still FAILS a Walmart run that just has nothing recorded", () => {
    const c = checkOffCycleArtifacts(run({ channel: "walmart_ecard", hasBankFile: false }));
    assert.equal(c.status, "fail");
    assert.match(String(c.detail[0]), /must be stated, not inferred/);
  });

  it("knows which channels produce no bank file", () => {
    assert.ok(CHANNELS_WITHOUT_BANK_FILE.has("venmo"));
    assert.ok(!CHANNELS_WITHOUT_BANK_FILE.has("ach"));
  });
});

describe("an advance is a loan", () => {
  const base: OffCycleRun = {
    payDate: "2026-08-26", kind: "advance", channel: "ach",
    people: ["Cerda, Francisco"], amount: 100,
  };

  it("FAILS an advance with no payback scheduled", () => {
    const c = checkAdvancePayback(base);
    assert.equal(c.status, "fail");
    assert.match(c.message, /nothing arranged to recover it/);
  });

  it("passes once the payback exists", () => {
    assert.equal(checkAdvancePayback({ ...base, paybackScheduled: true }).status, "pass");
  });

  it("does not demand a payback of a reimbursement", () => {
    assert.equal(checkAdvancePayback({ ...base, kind: "reimbursement" }).status, "pass");
  });
});

describe("void and reissue are two halves of one thing", () => {
  it("passes a properly paired correction", () => {
    // The real shape from PD 07.24.2026/_CORRECTION/.
    const c = checkVoidReissuePaired({
      voidedPerson: "Padilla, Rosie", voidedPaymentBatchId: 900,
      reissuedPerson: "Papillion, Adrianne", reissuedPaymentBatchId: 901,
      reason: "paid the wrong person",
    });
    assert.equal(c.status, "pass");
  });

  it("FAILS a void with no reissue recorded — the right person stays unpaid", () => {
    const c = checkVoidReissuePaired({
      voidedPerson: "Padilla, Rosie", voidedPaymentBatchId: 900,
      reissuedPerson: "Papillion, Adrianne", reissuedPaymentBatchId: null,
      reason: "paid the wrong person",
    });
    assert.equal(c.status, "fail");
  });

  it("requires a reason", () => {
    const c = checkVoidReissuePaired({
      voidedPerson: "A", voidedPaymentBatchId: 1,
      reissuedPerson: "B", reissuedPaymentBatchId: 2, reason: "  ",
    });
    assert.equal(c.status, "fail");
  });
});

describe("deactivated paycards", () => {
  it("FAILS a payment routed to a deactivated card", () => {
    const c = checkDeactivatedCards([
      { personId: 1, person: "A", cardDeactivated: true, currentChannel: "rapid_card" },
    ]);
    assert.equal(c.status, "fail");
    assert.match(c.message, /go nowhere/);
  });

  it("is fine once they are moved to ACH", () => {
    assert.equal(checkDeactivatedCards([
      { personId: 1, person: "A", cardDeactivated: true, currentChannel: "ach" },
    ]).status, "pass");
  });
});

describe("backfilling the channel from filename prose", () => {
  it("reads the real filenames in the tree", () => {
    assert.equal(channelFromFilename(
      "Bank Feed Advance LSI PD 08.12.2026 Off Cycle WALMART cards sent electronically this bank feed was not processed through our bank.txt"),
      "walmart_ecard");
    assert.equal(channelFromFilename(
      "Orgill Advance not actual bank file as money was sent via venmo PD 07.19.2026.txt"),
      "venmo");
    assert.equal(channelFromFilename(
      "Orgill Off Cycle advance Silva, Aaron PD 08.11.2026 walmart card given by Richard Deyarmin.txt"),
      "walmart_physical_card");
  });

  it("returns null rather than guessing", () => {
    assert.equal(channelFromFilename("some other file.xlsx"), null);
  });
});
