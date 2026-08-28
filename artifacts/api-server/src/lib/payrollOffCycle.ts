/**
 * Off-cycle runs — a different entity from the weekly payroll, not a variant.
 *
 * The evidence on disk is unambiguous. Off-cycle folders are flat with no
 * subfolders, hold 2 to 10 files rather than 180, are event-triggered rather
 * than weekly, and ten of the twelve observed were advances. There is no
 * timesheet stage, no changes workbook and no Expert Pay. Modelling them as a
 * thin weekly period would attach thirty steps that never apply.
 */

/**
 * ⚠️ HOW THE MONEY ACTUALLY LEFT — today this exists only as prose inside
 * filenames.
 *
 * Real examples from the tree:
 *   "…WALMART cards sent electronically this bank feed was not processed
 *    through our bank.txt"
 *   "…not actual bank file as money was sent via venmo…"
 *   "Orgill Off Cycle advance Silva, Aaron … walmart card given by Richard
 *    Deyarmin"
 *
 * A missing bank file means something different for each of these, and reading
 * it out of a filename is not a control. It is a field.
 */
export const DISBURSEMENT_CHANNELS = [
  "ach",
  "walmart_ecard",
  "walmart_physical_card",
  "venmo",
  "live_check",
  "rapid_card",
] as const;
export type DisbursementChannel = (typeof DISBURSEMENT_CHANNELS)[number];

/** Channels that legitimately produce NO bank file. */
export const CHANNELS_WITHOUT_BANK_FILE: ReadonlySet<DisbursementChannel> = new Set([
  "walmart_ecard", "walmart_physical_card", "venmo", "live_check",
]);

export const CHANNEL_LABEL: Record<DisbursementChannel, string> = {
  ach: "ACH",
  walmart_ecard: "Walmart e-card",
  walmart_physical_card: "Walmart physical card",
  venmo: "Venmo",
  live_check: "Live check",
  rapid_card: "Rapid paycard",
};

export type OffCycleKind = "advance" | "reimbursement" | "correction" | "void_reissue" | "other";

export type OffCycleRun = {
  payDate: string;
  kind: OffCycleKind;
  channel: DisbursementChannel;
  customer?: string | null;
  people: string[];
  amount?: number | null;
  /** Who approved it, and where that approval is filed. */
  approvedBy?: string | null;
  /** The four artifacts an off-cycle run should leave behind. */
  hasApprovalDocument?: boolean;
  hasTransactionBatchReport?: boolean;
  hasPaymentBatchReport?: boolean;
  hasBankFile?: boolean;
  /** ⚠️ Required when the channel produces no bank file. */
  noBankFileReason?: string | null;
  /** An advance that must be recovered from later pay. */
  paybackScheduled?: boolean;
};

export type OffCycleCheck = {
  check: string;
  status: "pass" | "fail" | "warn" | "info";
  message: string;
  detail: unknown[];
};

/**
 * The universal quad.
 *
 * Every off-cycle run in the tree carries an approval, a transaction batch
 * report, a payment batch report, and either a bank file OR a recorded reason
 * there is not one. The last clause is the whole point: "no bank file" is
 * normal for a Walmart card and alarming for an ACH, and only the channel
 * tells you which.
 */
export function checkOffCycleArtifacts(run: OffCycleRun): OffCycleCheck {
  const missing: string[] = [];
  if (!run.hasApprovalDocument) missing.push("approval document");
  if (!run.hasTransactionBatchReport) missing.push("transaction batch report");
  if (!run.hasPaymentBatchReport) missing.push("payment batch report");

  const bankFileExpected = !CHANNELS_WITHOUT_BANK_FILE.has(run.channel);
  if (bankFileExpected && !run.hasBankFile) {
    missing.push(`bank file (expected for ${CHANNEL_LABEL[run.channel]})`);
  }
  if (!bankFileExpected && !run.hasBankFile && !run.noBankFileReason) {
    missing.push(
      `a recorded reason there is no bank file — ${CHANNEL_LABEL[run.channel]} does not produce one, and that must be stated, not inferred`);
  }

  return {
    check: "off_cycle_artifacts",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? `${missing.length} missing: ${missing.join("; ")}`
      : "approval, both batch reports, and the bank file position are all accounted for",
    detail: missing,
  };
}

/**
 * ⚠️ An advance is a LOAN. It has to come back.
 *
 * Ten of the twelve off-cycle runs on disk were advances, and the ledger
 * carries "Advance Pay Back" rows against later periods. An advance recorded
 * without a payback scheduled is money out with nothing arranged to recover it.
 */
export function checkAdvancePayback(run: OffCycleRun): OffCycleCheck {
  if (run.kind !== "advance") {
    return { check: "advance_payback", status: "pass",
             message: "not an advance", detail: [] };
  }
  return {
    check: "advance_payback",
    status: run.paybackScheduled ? "pass" : "fail",
    message: run.paybackScheduled
      ? "payback deduction is scheduled"
      : "advance with NO payback scheduled — this is money out with nothing arranged to recover it",
    detail: run.paybackScheduled ? [] : [{ people: run.people, amount: run.amount }],
  };
}

/**
 * A void and its reissue are two halves of one correction.
 *
 * `PD 07.24.2026/_CORRECTION/` holds the shape: a voided payment batch report
 * for one person, a correction transaction batch, and a fresh payment batch
 * report for the other. Recording only the void leaves the correct person
 * unpaid; recording only the reissue double-pays.
 */
export type VoidReissue = {
  voidedPerson: string;
  voidedPaymentBatchId?: number | null;
  reissuedPerson: string;
  reissuedPaymentBatchId?: number | null;
  reason: string;
};

export function checkVoidReissuePaired(v: VoidReissue): OffCycleCheck {
  const problems: string[] = [];
  if (!v.voidedPaymentBatchId) problems.push("the void has no payment batch recorded");
  if (!v.reissuedPaymentBatchId) problems.push("the reissue has no payment batch recorded");
  if (!v.reason.trim()) problems.push("no reason recorded for the correction");

  return {
    check: "void_reissue_paired",
    status: problems.length ? "fail" : "pass",
    message: problems.length
      ? problems.join("; ")
      : `void for ${v.voidedPerson} paired with reissue to ${v.reissuedPerson}`,
    detail: problems,
  };
}

/**
 * ⚠️ Deactivated paycards.
 *
 * `Task List For tracking Rapid Deactivated cards` and `Contact import for
 * deactivated Rapid cards` are real files in the tree, and this process appears
 * in NO work instruction. A deactivated card that still has a payment routed to
 * it is money that goes nowhere and has to be reissued.
 */
export type PaycardStatus = {
  personId: number;
  person: string;
  cardDeactivated: boolean;
  /** Where their pay is currently routed. */
  currentChannel: DisbursementChannel;
};

export function checkDeactivatedCards(people: PaycardStatus[]): OffCycleCheck {
  const stranded = people.filter(
    (p) => p.cardDeactivated && p.currentChannel === "rapid_card");
  return {
    check: "deactivated_cards",
    status: stranded.length ? "fail" : "pass",
    message: stranded.length
      ? `${stranded.length} payment${stranded.length === 1 ? "" : "s"} routed to a DEACTIVATED card — it will go nowhere and need reissuing`
      : "no payments routed to a deactivated card",
    detail: stranded.map((p) => ({ personId: p.personId, person: p.person })),
  };
}

/** Parse the channel out of legacy filename prose, for backfilling old runs. */
export function channelFromFilename(name: string): DisbursementChannel | null {
  const s = name.toLowerCase();
  if (/venmo/.test(s)) return "venmo";
  if (/walmart/.test(s)) {
    return /e ?card|electronic/.test(s) ? "walmart_ecard" : "walmart_physical_card";
  }
  if (/rapid/.test(s)) return "rapid_card";
  if (/live check|physical check/.test(s)) return "live_check";
  if (/bank feed|ach/.test(s)) return "ach";
  return null;
}

export function runOffCycleChecks(run: OffCycleRun): OffCycleCheck[] {
  return [checkOffCycleArtifacts(run), checkAdvancePayback(run)];
}
