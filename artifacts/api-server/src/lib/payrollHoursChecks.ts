/**
 * Monday's hours checks, from the customers' own work instructions.
 *
 * These are the validations a processor runs by eye against two spreadsheets.
 * They are small, they are boring, and every one of them exists because it
 * caught something: a 24-hour shift from a missed clock-out, a person paid
 * someone else's overtime because the rows drifted by one, hours that stopped
 * short because a paste ran out before the names did.
 */

export type PunchRow = {
  employee: string;
  hours: number;
  /** Trienda's daily export carries this; most customers' do not. */
  payCategory?: string | null;
  date?: string | null;
};

export type TimesheetRow = {
  employee: string;
  /** Total for the week as the customer reported it. */
  hours: number;
  transactionCode?: string | null;
  shift?: string | null;
};

export type CheckResult = {
  check: string;
  status: "pass" | "fail" | "warn";
  message: string;
  detail: unknown[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * ⚠️ Nobody works more than 13 hours in a day.
 *
 * Straight from the instructions: "occasionally when someone forgets to clock
 * in/out in a certain way the system records it as a 24 hour shift". A genuine
 * 13-hour shift is possible but "highly unusual" — so this warns rather than
 * fails, and names the punches to look at.
 */
export const MAX_DAILY_HOURS = 13;

export function checkNoLongShifts(punches: PunchRow[]): CheckResult {
  const over = punches.filter((p) => p.hours > MAX_DAILY_HOURS);
  return {
    check: "no_long_shifts",
    status: over.length ? "warn" : "pass",
    message: over.length
      ? `${over.length} punch${over.length === 1 ? "" : "es"} over ${MAX_DAILY_HOURS} hours — far more likely a missed clock-out than a real shift`
      : `no punch over ${MAX_DAILY_HOURS} hours`,
    detail: over.map((p) => ({ employee: p.employee, date: p.date, hours: p.hours })),
  };
}

/**
 * Customers whose daily punch export needs rows dropped before it will tie.
 *
 * ⚠️ TRIENDA FILTERS `PREM`, PENDA DOES NOT. They arrive in the same format
 * from the same corporate system, which is exactly why this is written down
 * rather than left to memory — applying Trienda's filter to Penda silently
 * removes real hours.
 */
export const PUNCH_CATEGORY_EXCLUSIONS: Record<string, string[]> = {
  "Trienda Holdings": ["prem"],
};

export function applyPunchExclusions(punches: PunchRow[], customer: string): PunchRow[] {
  const excl = PUNCH_CATEGORY_EXCLUSIONS[customer];
  if (!excl?.length) return punches;
  return punches.filter((p) => {
    const cat = (p.payCategory ?? "").toLowerCase();
    return !excl.some((x) => cat.includes(x));
  });
}

/**
 * The client's weekly totals must agree with their own daily punches.
 *
 * Tolerance is 0.05, quoted from the instructions: "they should be the same
 * give or take .05 or less for rounding".
 */
export const TIE_TOLERANCE = 0.05;

export function checkTimesheetVsPunches(
  timesheet: TimesheetRow[],
  punches: PunchRow[],
  customer: string,
): CheckResult {
  const kept = applyPunchExclusions(punches, customer);
  const tsTotal = round2(timesheet.reduce((s, r) => s + r.hours, 0));
  const punchTotal = round2(kept.reduce((s, r) => s + r.hours, 0));
  const diff = round2(tsTotal - punchTotal);
  const excluded = punches.length - kept.length;
  return {
    check: "timesheet_vs_punches",
    status: Math.abs(diff) <= TIE_TOLERANCE ? "pass" : "fail",
    message:
      `timesheet ${tsTotal} vs punches ${punchTotal} (diff ${diff})` +
      (excluded ? `, ${excluded} punch rows excluded for ${customer}` : ""),
    detail: Math.abs(diff) <= TIE_TOLERANCE ? [] : [{ tsTotal, punchTotal, diff, excluded }],
  };
}

/**
 * Per-person spot check.
 *
 * The instructions say to compare "at least 2 people", and for a small customer
 * like WB Manufacturing to compare all of them. This compares everyone it can
 * match and reports who disagrees — there is no reason to check two when the
 * data for all of them is right there.
 */
export function checkPerPersonTotals(
  timesheet: TimesheetRow[],
  punches: PunchRow[],
  customer: string,
): CheckResult {
  const kept = applyPunchExclusions(punches, customer);
  const byPerson = new Map<string, number>();
  for (const p of kept) {
    const k = normalizeName(p.employee);
    byPerson.set(k, round2((byPerson.get(k) ?? 0) + p.hours));
  }
  const tsByPerson = new Map<string, number>();
  for (const t of timesheet) {
    const k = normalizeName(t.employee);
    tsByPerson.set(k, round2((tsByPerson.get(k) ?? 0) + t.hours));
  }

  const off: unknown[] = [];
  for (const [k, tsHours] of tsByPerson) {
    const punchHours = byPerson.get(k);
    if (punchHours === undefined) continue; // handled by the alignment check
    if (Math.abs(round2(tsHours - punchHours)) > TIE_TOLERANCE) {
      off.push({ employee: k, timesheet: tsHours, punches: punchHours,
                 diff: round2(tsHours - punchHours) });
    }
  }
  return {
    check: "per_person_totals",
    status: off.length ? "fail" : "pass",
    message: off.length ? `${off.length} people disagree between the two reports`
                        : `all ${tsByPerson.size} matched people agree`,
    detail: off,
  };
}

export function normalizeName(n: string): string {
  return (n ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * ⚠️ The alignment check — this is the one that pays someone else's overtime.
 *
 * The instructions are explicit about the failure: "it is really easy to get off
 * by one row or have an error because people have the same last names and pay
 * the wrong person OT". And after pasting: "the last pasted value should line up
 * with the last row with a name on it — if it doesn't there is something missing
 * and you should start over".
 *
 * So this compares the two name lists as ORDERED sequences, not as sets. Two
 * lists can contain the same names and still be misaligned.
 */
export function checkNameAlignment(
  templateNames: string[],
  customerNames: string[],
): CheckResult {
  const a = templateNames.map(normalizeName);
  const b = customerNames.map(normalizeName);

  if (a.length !== b.length) {
    return {
      check: "name_alignment",
      status: "fail",
      message: `row counts differ — template ${a.length}, customer file ${b.length}. The paste will not line up.`,
      detail: [{
        onlyInTemplate: a.filter((n) => !b.includes(n)).slice(0, 20),
        onlyInCustomerFile: b.filter((n) => !a.includes(n)).slice(0, 20),
      }],
    };
  }

  const off: unknown[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) off.push({ row: i + 1, template: a[i], customerFile: b[i] });
  }
  return {
    check: "name_alignment",
    status: off.length ? "fail" : "pass",
    message: off.length
      ? `${off.length} rows are misaligned — hours would land on the wrong person`
      : `all ${a.length} rows line up`,
    detail: off.slice(0, 20),
  };
}

/**
 * A person appearing twice on the same transaction code.
 *
 * From the instructions: someone working regular or OT "on different shifts …
 * results in two lines of Reg or OT for the same person which throws off the
 * validation process". They are legitimate rows that must be COMBINED, not an
 * error to reject — so this reports them for merging.
 */
export function checkDuplicateCodeRows(rows: TimesheetRow[]): CheckResult {
  const seen = new Map<string, TimesheetRow[]>();
  for (const r of rows) {
    const k = `${normalizeName(r.employee)}|${r.transactionCode ?? ""}`;
    const arr = seen.get(k);
    if (arr) arr.push(r);
    else seen.set(k, [r]);
  }
  const dupes = [...seen.entries()].filter(([, v]) => v.length > 1);
  return {
    check: "duplicate_code_rows",
    status: dupes.length ? "warn" : "pass",
    message: dupes.length
      ? `${dupes.length} people have two rows on the same code — combine them before matching names`
      : "no duplicated code rows",
    detail: dupes.map(([k, v]) => ({
      key: k,
      rows: v.length,
      shifts: v.map((r) => r.shift ?? null),
      combinedHours: round2(v.reduce((s, r) => s + r.hours, 0)),
    })),
  };
}

/**
 * RT + OT must equal the reported total.
 *
 * WB's instructions note the Timesheet-processing tab carries conditional
 * formatting "that will let you know if the RT and the OT do not match the
 * total". Same check, without needing to notice a colour.
 */
export function checkRtOtSplit(total: number, rt: number, ot: number): CheckResult {
  const diff = round2(total - round2(rt + ot));
  return {
    check: "rt_ot_split",
    status: Math.abs(diff) <= 0.004 ? "pass" : "fail",
    message: `total ${round2(total)} vs RT ${round2(rt)} + OT ${round2(ot)} = ${round2(rt + ot)} (diff ${diff})`,
    detail: Math.abs(diff) <= 0.004 ? [] : [{ total, rt, ot, diff }],
  };
}

/** Everything Monday needs, in one call. */
export function runHoursChecks(input: {
  customer: string;
  timesheet: TimesheetRow[];
  punches: PunchRow[];
  templateNames?: string[];
  reportedTotal?: number;
  reportedRt?: number;
  reportedOt?: number;
}): CheckResult[] {
  const out: CheckResult[] = [
    checkNoLongShifts(input.punches),
    checkTimesheetVsPunches(input.timesheet, input.punches, input.customer),
    checkPerPersonTotals(input.timesheet, input.punches, input.customer),
    checkDuplicateCodeRows(input.timesheet),
  ];
  if (input.templateNames) {
    out.push(checkNameAlignment(input.templateNames, input.timesheet.map((t) => t.employee)));
  }
  if (input.reportedTotal !== undefined && input.reportedRt !== undefined
      && input.reportedOt !== undefined) {
    out.push(checkRtOtSplit(input.reportedTotal, input.reportedRt, input.reportedOt));
  }
  return out;
}
