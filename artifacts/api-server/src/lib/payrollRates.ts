/**
 * Rate changes, terminations and the deductions that must stop with them.
 *
 * Thursday and Friday work, and the part of the week most likely to be
 * "finished" while quietly not having taken effect.
 */

/**
 * Customers who keep time in Zenople rather than sending a timesheet.
 *
 * ⚠️ THIS IS A SEED, NOT THE RULE. It is the SOP's list ("currently Alamco,
 * Bell Lumber and Shusters"), and only TWO of the three are verified against
 * Zenople's actual roster: `Alamco Wood Products Inc` and
 * `Shuster's Building Components` both appear in AP 2026-08-23.
 *
 * ⚠️ "Bell Lumber" DOES NOT. Two distinct Bell entities exist in the file tree
 * — `Bell Lumber TransactionBatchReport` AND `Bell Timber TransactionBatchReport`
 * in the same period — and `Bell Timber` has a Client TS file, which is evidence
 * AGAINST it keeping time in Zenople. Neither appears in the August roster, so
 * they may be inactive or named differently there. Unresolved, and asked.
 *
 * The real source of truth is `payroll_customers.timekeeping_mode`, resolved
 * per customer. This list only seeds it, and the matcher below is deliberately
 * tolerant so an exact-name mismatch cannot silently skip the
 * "update transactions" step — which would be a false pass on a rate change.
 */
export const ZENOPLE_TIMEKEEPING_CUSTOMERS: ReadonlySet<string> = new Set([
  "Alamco Wood Products Inc",
  "Bell Lumber",
  "Bell Timber",
  "Shuster's Building Components",
]);

/** Fold a customer name so punctuation and casing drift cannot break a match. */
function foldCustomer(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does this customer keep time in Zenople?
 *
 * Matches on a folded prefix rather than an exact string, so
 * "Shuster's Building Components", "Shusters" and "shuster s building
 * components" all resolve. An exact-match miss here does not error — it quietly
 * skips a step that has to happen for the rate change to take effect.
 */
export function keepsTimeInZenople(customer: string): boolean {
  const c = foldCustomer(customer);
  if (!c) return false;
  for (const known of ZENOPLE_TIMEKEEPING_CUSTOMERS) {
    const k = foldCustomer(known);
    const head = k.split(" ")[0] ?? k;
    // "shusters" vs "shuster s building components": compare on the first token
    // both ways, which is what actually distinguishes these four from the rest.
    if (c === k || c.startsWith(k) || k.startsWith(c)
        || c.startsWith(head) || c.replace(/\s+/g, "").startsWith(head.replace(/\s+/g, ""))) {
      return true;
    }
  }
  return false;
}

export type MarkupTier = "Year1" | "Year2" | "Year3";

export type MarkupChange = {
  personId: number;
  person: string;
  customer: string;
  assignmentId: number;
  from: MarkupTier;
  to: MarkupTier;
  effectiveDate: string;
  /** Set once the assignment itself has been opened and saved. */
  assignmentUpdated?: boolean;
  /** Only meaningful for Zenople-timekeeping customers. */
  transactionsUpdated?: boolean;
  /** The rate-change comment logged against the assignment. */
  commentLogged?: boolean;
};

export type RateCheck = {
  check: string;
  status: "pass" | "fail" | "warn" | "info";
  message: string;
  detail: unknown[];
};

/**
 * ⚠️ THE TRAP THAT MAKES THIS TILE WORTH BUILDING.
 *
 * Changing a markup at the JOB level does not propagate to assignments — and
 * Zenople reports success anyway. The work instruction proves it with a worked
 * example: "I selected Ricky's assignment and saved and Zenople indicated that
 * the assignments were updated successfully. However when I go to Ricky's
 * actual assignment the Mark up is still the old mark up."
 *
 * So a markup change is NOT done when Zenople says it is. Each assignment has
 * to be opened, and this refuses to call the change complete until that is
 * recorded per assignment.
 */
export function checkMarkupPropagation(changes: MarkupChange[]): RateCheck {
  const notOpened = changes.filter((c) => c.assignmentUpdated !== true);
  return {
    check: "markup_propagation",
    status: notOpened.length ? "fail" : "pass",
    message: notOpened.length
      ? `${notOpened.length} assignment${notOpened.length === 1 ? "" : "s"} not individually opened — Zenople reports success without propagating, so a job-level change alone is not done`
      : `all ${changes.length} assignments individually updated`,
    detail: notOpened.map((c) => ({
      personId: c.personId, person: c.person, customer: c.customer,
      assignmentId: c.assignmentId, from: c.from, to: c.to,
    })),
  };
}

/**
 * ⚠️ The extra step for customers who keep time in Zenople.
 *
 * "If the client is a client that keeps time in Zenople … it is necessary to
 * complete an additional step to update the bill rate on the existing
 * timesheet. This is necessary EVEN IF you say yes to the pop up message."
 * TMS, into the batch, select the person, yellow star, update transactions.
 */
export function checkTransactionUpdates(changes: MarkupChange[]): RateCheck {
  const needing = changes.filter((c) => keepsTimeInZenople(c.customer));
  const missing = needing.filter((c) => c.transactionsUpdated !== true);
  return {
    check: "transaction_updates",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? `${missing.length} rate change${missing.length === 1 ? "" : "s"} at a Zenople-timekeeping customer still need "update transactions" on the existing timesheet`
      : needing.length
        ? `all ${needing.length} Zenople-timekeeping changes had transactions updated`
        : "no Zenople-timekeeping customers in this batch",
    detail: missing.map((c) => ({
      personId: c.personId, person: c.person, customer: c.customer,
      step: "TMS > the batch > select the person > yellow star > update transactions",
    })),
  };
}

/** A rate change is not documented until its comment exists. */
export function checkRateComments(changes: MarkupChange[]): RateCheck {
  const missing = changes.filter((c) => c.commentLogged !== true);
  return {
    check: "rate_comments",
    status: missing.length ? "warn" : "pass",
    message: missing.length
      ? `${missing.length} rate change${missing.length === 1 ? "" : "s"} without a rate-change comment — the pay history is built from these`
      : "every rate change has its comment",
    detail: missing.map((c) => ({
      personId: c.personId, person: c.person,
      suggested: `updated mark up rate to ${c.to} bill rate effective ${c.effectiveDate}`,
    })),
  };
}

export type Termination = {
  personId: number;
  person: string;
  customer: string;
  lastDayWorked: string;
  assignmentEnded?: boolean;
  /** Housing, transportation and any other recurring deduction. */
  deductionsDeactivated?: boolean;
  /** True when a pro-rate on this check must carry to the next period. */
  hasProRateOnThisCheck?: boolean;
};

/**
 * Terminations, and the deductions that have to stop with them.
 *
 * ⚠️ Ending the assignment without deactivating the deductions is the failure
 * that keeps charging rent to somebody who has left. The checklist has them as
 * two separate lines for exactly that reason, and this keeps them paired.
 */
export function checkTerminations(terms: Termination[]): RateCheck[] {
  const assignmentOpen = terms.filter((t) => t.assignmentEnded !== true);
  const deductionsLive = terms.filter((t) => t.deductionsDeactivated !== true);

  return [
    {
      check: "assignments_ended",
      status: assignmentOpen.length ? "fail" : "pass",
      message: assignmentOpen.length
        ? `${assignmentOpen.length} termination${assignmentOpen.length === 1 ? "" : "s"} without the assignment ended`
        : `all ${terms.length} assignments ended`,
      detail: assignmentOpen.map((t) => ({ personId: t.personId, person: t.person,
                                           lastDayWorked: t.lastDayWorked })),
    },
    {
      check: "deductions_deactivated",
      status: deductionsLive.length ? "fail" : "pass",
      message: deductionsLive.length
        ? `${deductionsLive.length} terminated person${deductionsLive.length === 1 ? "" : "s"} still carrying live deductions — they will be charged rent after leaving`
        : "every terminated person's deductions are deactivated",
      detail: deductionsLive.map((t) => ({ personId: t.personId, person: t.person,
                                           customer: t.customer, lastDayWorked: t.lastDayWorked })),
    },
  ];
}

/**
 * Anyone whose housing or transportation was pro-rated on this check and whose
 * deduction stops — they belong on NEXT period's changes file.
 *
 * The checklist's own closing step: "Filter for and copy any employees who are
 * stopping housing or transportation that were pro rated on this check to the
 * next payroll changes spreadsheet." Left to memory it is the thing that gets
 * dropped when the week runs long.
 */
export function proRateStopsToCarry(terms: Termination[]): RateCheck {
  const carry = terms.filter((t) => t.hasProRateOnThisCheck === true);
  return {
    check: "pro_rate_stops_carry",
    status: carry.length ? "info" : "pass",
    message: carry.length
      ? `${carry.length} pro-rated stop${carry.length === 1 ? "" : "s"} to carry to next period's changes file`
      : "no pro-rated stops to carry",
    detail: carry.map((t) => ({ personId: t.personId, person: t.person,
                                customer: t.customer, lastDayWorked: t.lastDayWorked })),
  };
}

/**
 * ⚠️ Deactivate the OLD markups after adding the new ones.
 *
 * "Then deactivate the existing markups so that they cannot accidentally be
 * assigned." A live superseded markup is a rate waiting to be picked by
 * mistake.
 */
export function checkOldMarkupsDeactivated(
  customer: string, activeTiers: MarkupTier[], currentTier: MarkupTier,
): RateCheck {
  const stale = activeTiers.filter((t) => t !== currentTier);
  return {
    check: "old_markups_deactivated",
    status: stale.length ? "warn" : "pass",
    message: stale.length
      ? `${customer} still has ${stale.join(", ")} active alongside ${currentTier} — deactivate them so they cannot be picked by mistake`
      : `${customer} has only ${currentTier} active`,
    detail: stale.map((t) => ({ customer, staleTier: t })),
  };
}

export function runRateChecks(input: {
  markupChanges?: MarkupChange[];
  terminations?: Termination[];
}): RateCheck[] {
  const out: RateCheck[] = [];
  if (input.markupChanges?.length) {
    out.push(checkMarkupPropagation(input.markupChanges));
    out.push(checkTransactionUpdates(input.markupChanges));
    out.push(checkRateComments(input.markupChanges));
  }
  if (input.terminations?.length) {
    out.push(...checkTerminations(input.terminations));
    out.push(proRateStopsToCarry(input.terminations));
  }
  return out;
}
