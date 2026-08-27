/**
 * Pro-rating housing, transportation and the housing fringe for a part week.
 *
 * The rule is `amount x days / 7`, confirmed against the `Pro Rate Calculations`
 * tab of the reference workbook: 69.23 over 1 day gives 9.89, over 3 days
 * 29.67, over 5 days 49.45; 40 over 3 days gives 17.142857…
 *
 * ⚠️ The tab stores some results UNROUNDED — 17.142857142857142 sits in the
 * cell — while others land clean because 69.23 happens to divide by 7 exactly.
 * A deduction has to be a money amount, so this rounds to cents and says so.
 * Copying the raw cell into an import is how a fraction of a cent reaches a
 * paycheck.
 *
 * ⚠️ ONE PERSON USUALLY GENERATES THREE ROWS — housing fringe, pro-rated rent
 * and pro-rated transportation — and they do NOT share an effective date: the
 * fringe keys off first-day-housing, the rent off first-day-worked, and
 * transportation off first-day-transport. Pro-rating one and not the others
 * leaves the fringe balance out, which is tie-out 4.
 */

export type ProRateInput = {
  /** The full weekly amount, e.g. 69.23 rent or 40 transportation. */
  weeklyAmount: number;
  /** Days of the week the person is charged, 0-7. */
  days: number;
};

export type ProRateResult = {
  weeklyAmount: number;
  days: number;
  /** Rounded to cents — this is the number that goes on the import. */
  amount: number;
  /** Unrounded, so a reviewer can see what was dropped. */
  exact: number;
};

const DAYS_IN_WEEK = 7;

/**
 * Round half away from zero — a refund rounds the same distance as a charge.
 *
 * ⚠️ Works on a value ALREADY in cents. Rounding `amount * 100` directly is
 * wrong: 0.245 * 100 is 24.499999999999996 in IEEE754, so a naive round gives
 * 0.24. Money is computed in integer cents here for that reason.
 */
function roundHalfAway(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

export function proRate({ weeklyAmount, days }: ProRateInput): ProRateResult {
  if (!Number.isFinite(weeklyAmount) || !Number.isFinite(days)) {
    throw new Error("proRate needs finite numbers");
  }
  if (days < 0 || days > DAYS_IN_WEEK) {
    throw new Error(`days must be 0-${DAYS_IN_WEEK}, got ${days}`);
  }
  // Convert to cents FIRST, then divide, so the only rounding is the final one.
  const weeklyCents = roundHalfAway(weeklyAmount * 100);
  const cents = roundHalfAway((weeklyCents * days) / DAYS_IN_WEEK);
  return {
    weeklyAmount,
    days,
    amount: cents / 100,
    exact: (weeklyAmount * days) / DAYS_IN_WEEK,
  };
}

/** The three things that pro-rate together, each with its own effective date. */
export const PRO_RATE_KINDS = ["housing_fringe", "rent", "transportation"] as const;
export type ProRateKind = (typeof PRO_RATE_KINDS)[number];

export type ProRateRow = ProRateResult & {
  kind: ProRateKind;
  /** FDH / FDW / FDT, or the last-day equivalent on a stop. */
  effectiveDate: string;
  label: string;
};

export type ProRatePersonInput = {
  /** Weekly housing rate. Rates seen in the data: 175, 130, 69.23. */
  housingWeekly?: number;
  /** Weekly transportation rate. 40 throughout the data. */
  transportWeekly?: number;
  /** First (or last) day housing — drives the FRINGE row. */
  housingDate?: string;
  housingDays?: number;
  /** First (or last) day worked — drives the RENT row. */
  workedDate?: string;
  workedDays?: number;
  /** First (or last) day transport — drives the TRANSPORT row. */
  transportDate?: string;
  transportDays?: number;
};

/**
 * Build every pro-rate row one person needs.
 *
 * Emits only the rows the inputs support, rather than inventing zeros — a
 * missing transport date means transportation was not being charged, which is
 * different from being charged nothing.
 */
export function proRatePerson(p: ProRatePersonInput): ProRateRow[] {
  const rows: ProRateRow[] = [];

  if (p.housingWeekly != null && p.housingDate && p.housingDays != null) {
    rows.push({
      ...proRate({ weeklyAmount: p.housingWeekly, days: p.housingDays }),
      kind: "housing_fringe", effectiveDate: p.housingDate, label: "Housing Fringe",
    });
  }
  if (p.housingWeekly != null && p.workedDate && p.workedDays != null) {
    rows.push({
      ...proRate({ weeklyAmount: p.housingWeekly, days: p.workedDays }),
      kind: "rent", effectiveDate: p.workedDate, label: "Pro rated rent",
    });
  }
  if (p.transportWeekly != null && p.transportDate && p.transportDays != null) {
    rows.push({
      ...proRate({ weeklyAmount: p.transportWeekly, days: p.transportDays }),
      kind: "transportation", effectiveDate: p.transportDate,
      label: "Pro rated Transportation",
    });
  }
  return rows;
}

/**
 * Does the fringe row match the rent row?
 *
 * They are pro-rated off DIFFERENT dates by design, so they are usually
 * different numbers — this does not compare them. It catches the real mistake:
 * a rent row pro-rated while the fringe row was left whole, or vice versa.
 */
export function fringeAndRentAgree(rows: ProRateRow[]): boolean {
  const fringe = rows.find((r) => r.kind === "housing_fringe");
  const rent = rows.find((r) => r.kind === "rent");
  if (!fringe || !rent) return true;
  const bothPartial = fringe.days < 7 && rent.days < 7;
  const bothWhole = fringe.days === 7 && rent.days === 7;
  return bothPartial || bothWhole;
}
