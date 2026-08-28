import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  holidayLookback, assessEligibility, assessAll, buildHolidayImport, holidaySummary,
  HOLIDAY_PAY_RATE, REQUIRED_CHECK_DATES, REQUIRED_WORKED_HOURS,
  type HolidayPaymentRow, type AssignmentRow,
} from "../payrollHoliday";

const win = holidayLookback("2026-07-03"); // Independence Day, a Friday

/** n weekly check dates ending just before the look-back closes. */
function weeklyChecks(personId: number, n: number, hoursEach = 40,
                      opts: { checkNumber?: (i: number) => string } = {}): HolidayPaymentRow[] {
  const out: HolidayPaymentRow[] = [];
  let d = new Date(`${win.end}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push({
      personId, name: "DOE, JANE",
      checkDate: d.toISOString().slice(0, 10),
      checkNumber: opts.checkNumber ? opts.checkNumber(i) : String(10000 + i),
      rtHours: hoursEach,
    });
    d = new Date(d.getTime() - 7 * 86_400_000);
  }
  return out;
}

const active: AssignmentRow[] = [{ personId: 1, hireDate: "2024-01-01", endDate: null }];

describe("the look-back window", () => {
  it("measures 26 weeks back from the START of the holiday's week", () => {
    // A Friday holiday and a Monday holiday in the same week get the identical
    // window, which is what "the week that the holiday is in" means.
    const fri = holidayLookback("2026-07-03");
    const mon = holidayLookback("2026-06-29");
    assert.deepEqual(fri, mon);
  });

  it("ends the day before the holiday's week opens", () => {
    assert.equal(win.end, "2026-06-27");
    assert.equal(win.holidayWeekStart, "2026-06-28");
  });

  it("spans exactly 26 weeks", () => {
    const days = (Date.parse(`${win.holidayWeekStart}T00:00:00Z`)
                - Date.parse(`${win.start}T00:00:00Z`)) / 86_400_000;
    assert.equal(days, 26 * 7);
  });
});

describe("eligibility", () => {
  it("passes someone with 26 weeks and enough hours", () => {
    const r = assessEligibility(1, weeklyChecks(1, 26, 40), active, win);
    assert.equal(r.eligible, true, r.reasons.join("; "));
    assert.equal(r.uniqueCheckDates, 26);
    assert.equal(r.workedHours, 1040);
  });

  it("FAILS at 25 check dates and says so", () => {
    const r = assessEligibility(1, weeklyChecks(1, 25, 40), active, win);
    assert.equal(r.eligible, false);
    assert.match(r.reasons[0]!, /25 unique check dates, needs 26/);
  });

  it("FAILS under 720 worked hours even with 26 check dates", () => {
    // 26 weeks at 20 hours is 520 — enough weeks, not enough work.
    const r = assessEligibility(1, weeklyChecks(1, 26, 20), active, win);
    assert.equal(r.eligible, false);
    assert.match(r.reasons.join(), /520 worked hours, needs 720/);
  });

  it("EXCLUDES holiday and PTO from worked hours", () => {
    const rows = weeklyChecks(1, 26, 20).map((p) => ({
      ...p, holidayHours: 8, ptoHours: 8,
    }));
    const r = assessEligibility(1, rows, active, win);
    // 520 worked; the 416 hours of holiday and PTO must not rescue it.
    assert.equal(r.workedHours, 520);
    assert.equal(r.eligible, false);
  });
});

describe("voids and reversals — the part that takes an afternoon", () => {
  it("counts DISTINCT check dates, so a void plus reissue is ONE week", () => {
    // 26 dates, but one of them has a void and a reissue: 27 rows, 26 dates.
    const base = weeklyChecks(1, 26, 40);
    const dupe: HolidayPaymentRow = { ...base[0]!, checkNumber: "V9001" };
    const r = assessEligibility(1, [...base, dupe], active, win);
    assert.equal(r.uniqueCheckDates, 26, "rows must not be counted as weeks");
    assert.equal(r.eligible, true);
  });

  it("does NOT let a void manufacture the 26th week", () => {
    // 25 real dates plus a void on an existing date is still 25 weeks.
    const base = weeklyChecks(1, 25, 40);
    const dupe: HolidayPaymentRow = { ...base[0]!, checkNumber: "R9001" };
    const r = assessEligibility(1, [...base, dupe], active, win);
    assert.equal(r.uniqueCheckDates, 25);
    assert.equal(r.eligible, false);
  });

  it("does not count a voided cheque's hours as worked", () => {
    const base = weeklyChecks(1, 26, 40);
    const voided: HolidayPaymentRow = { ...base[0]!, checkNumber: "V9001", rtHours: 40 };
    const r = assessEligibility(1, [...base, voided], active, win);
    assert.equal(r.workedHours, 1040, "the voided 40 hours must not be added");
  });

  it("reports which dates carried a void, so the manual review is targeted", () => {
    const base = weeklyChecks(1, 26, 40);
    const voided: HolidayPaymentRow = { ...base[3]!, checkNumber: "V9001" };
    const r = assessEligibility(1, [...base, voided], active, win);
    assert.deepEqual(r.voidedCheckDates, [base[3]!.checkDate]);
  });

  it("treats an ordinary numeric cheque as neither", () => {
    const r = assessEligibility(1, weeklyChecks(1, 26, 40), active, win);
    assert.equal(r.voidedCheckDates.length, 0);
  });
});

describe("assignment conditions", () => {
  it("FAILS someone whose assignment has ended", () => {
    const r = assessEligibility(1, weeklyChecks(1, 26, 40),
      [{ personId: 1, hireDate: "2024-01-01", endDate: "2026-06-20" }], win);
    assert.equal(r.eligible, false);
    assert.match(r.reasons.join(), /assignment ended/);
  });

  it("FAILS someone hired after the look-back opened", () => {
    const r = assessEligibility(1, weeklyChecks(1, 26, 40),
      [{ personId: 1, hireDate: "2026-05-01", endDate: null }], win);
    assert.equal(r.eligible, false);
    assert.match(r.reasons.join(), /after the look-back opened/);
  });

  it("FAILS someone who quit before the check date", () => {
    // Otherwise eligible, but they will not be working when it pays.
    const r = assessEligibility(1, weeklyChecks(1, 26, 40), active, win,
      { quitBeforeCheckDate: true });
    assert.equal(r.eligible, false);
    assert.match(r.reasons.join(), /quit before the check date/);
  });

  it("FAILS someone with no assignment row at all", () => {
    const r = assessEligibility(1, weeklyChecks(1, 26, 40), [], win);
    assert.equal(r.eligible, false);
    assert.match(r.reasons.join(), /no assignment found/);
  });
});

describe("the import file", () => {
  const lookup = () => ({ customer: "Penda Corp", person: "DOE, JANE",
                          ssn: "XXX-XX-1234", jobId: "J1" });

  it("uses the flat rate with every bill column zero", () => {
    const results = assessAll(weeklyChecks(1, 26, 40), active, win);
    const { rows } = buildHolidayImport(results, lookup, "2026-06-27");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["Pay Rate"], HOLIDAY_PAY_RATE);
    assert.equal(rows[0]!["Pay Unit"], 1);
    assert.equal(rows[0]!["Bill Unit"], 0);
    assert.equal(rows[0]!["Bill Rate"], 0);
    assert.equal(rows[0]!["Item Bill"], 0);
  });

  it("emits nothing for an ineligible person", () => {
    const results = assessAll(weeklyChecks(1, 10, 40), active, win);
    assert.equal(buildHolidayImport(results, lookup, "2026-06-27").rows.length, 0);
  });

  it("REPORTS a person it cannot look up rather than writing blanks", () => {
    const results = assessAll(weeklyChecks(1, 26, 40), active, win);
    const out = buildHolidayImport(results, () => undefined, "2026-06-27");
    assert.equal(out.rows.length, 0);
    assert.deepEqual(out.skipped, [1]);
  });
});

describe("the summary", () => {
  it("costs the run at the flat rate", () => {
    const results = assessAll(
      [...weeklyChecks(1, 26, 40), ...weeklyChecks(2, 26, 40).map((p) => ({ ...p, personId: 2 }))],
      [...active, { personId: 2, hireDate: "2024-01-01", endDate: null }], win);
    const s = holidaySummary(results);
    assert.equal(s.eligible, 2);
    assert.equal(s.totalCost, 2 * HOLIDAY_PAY_RATE);
  });

  it("counts the thresholds it used", () => {
    assert.equal(REQUIRED_CHECK_DATES, 26);
    assert.equal(REQUIRED_WORKED_HOURS, 720);
  });
});
