/**
 * What a file in a PD folder actually is.
 *
 * ⚠️ FILENAMES ARE NOT A RELIABLE KEY. Across 3,636 files the same artifact is
 * written many ways — `Monday batch` and `Monday Batch`, `Shuster` and
 * `Shusters`, `FOR IMPORT` and `for imort`, `Off Cycle` and `off cycle`. So this
 * classifies by pattern against a folded string and never exact-matches.
 *
 * The point is not tidiness: a tile that wants to say "the fringe import exists
 * and was written at 09:12" has to recognise the file under whichever spelling
 * it got that week.
 */

export const ARTIFACT_KINDS = [
  "master_export_raw",        // the original Zenople download — the true source
  "master_export",            // the xlsx working copy
  "master_import",            // FOR IMPORT, ready to load
  "master_import_no_driver",  // FOR IMPORT with driver pay units removed
  "customer_template",        // KFIWeeklyTimesheetExport <customer> Import
  "client_timesheet",         // what the customer sent back
  "daily_punches",            // daily clock in / clock out
  "driver_timesheet",
  "driver_pay_units",
  "fringe_import",
  "deduction_import",         // housing + transportation deductions FOR IMPORT
  "holiday_eligibility",
  "holiday_import",
  "transaction_batch_report",
  "payment_batch_report",
  "bank_feed",
  "expert_pay",               // ⚠️ SENSITIVE — unmasked SSNs
  "changes_workbook",
  "documentation",
  "approval_email",
  "advance",
  "void_or_correction",
  "paycard",                  // Rapid card deactivation tracking
  "work_instruction",
  "reference_analysis",   // standing cost calculators / occupancy models
  "screen_recording",
  "unknown",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Files whose CONTENTS must never be read into the app.
 *
 * `Expert Pay/CS Expert Pay PD <d>.csv` carries UNMASKED nine-digit SSNs —
 * everything else in the tree is masked `XXX-XX-nnnn`. The bridge records that
 * the file exists and its timestamp; it never opens it.
 */
export const SENSITIVE_KINDS: ReadonlySet<ArtifactKind> = new Set(["expert_pay"]);

const fold = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/** Ordered — first match wins, so the most specific patterns come first. */
const RULES: Array<[RegExp, ArtifactKind]> = [
  [/cs expert pay|expert pay/, "expert_pay"],
  [/holiday pay eligibility|holiday pay payment detail|holiday pay active assign/, "holiday_eligibility"],
  [/holiday pay for import/, "holiday_import"],
  [/rapid|deactivated cards/, "paycard"],

  [/original download/, "master_export_raw"],
  [/master external.*(without|witout) driver/, "master_import_no_driver"],
  [/monday batch.*(without) driver/, "master_import_no_driver"],
  [/master external.*(fringe|mn esst|referral|cell|ach|expense|refund)/, "fringe_import"],
  [/master external.*for import|monday batch.*for import/, "master_import"],
  [/master external/, "master_export"],

  [/housing and transportation deductions|housing deductions for import|transportation deductions for import/, "deduction_import"],
  [/fringe for import|fringe import/, "fringe_import"],

  [/driver pay units|driver_pay_units/, "driver_pay_units"],
  [/driver timecards|driver only|driver timesheet/, "driver_timesheet"],
  [/kfiweeklytimesheetexport/, "customer_template"],

  [/daily punches|daily clock in|clock in and clock out/, "daily_punches"],
  [/transactionbatchreport|transaction batch report/, "transaction_batch_report"],
  [/paymentbatchreport|payment batch report/, "payment_batch_report"],
  [/bank feed/, "bank_feed"],

  [/payroll changes for pd|payroll changes pd/, "changes_workbook"],
  [/advance/, "advance"],
  [/void|correction|reissue/, "void_or_correction"],
  [/approval|email from|permission to approve/, "approval_email"],
  [/work instruction|how to |instructions/, "work_instruction"],
];

/**
 * Folders whose meaning is unambiguous, checked BEFORE the filename rules.
 *
 * ⚠️ Order matters here. A file in `Documentation/` IS documentation even when
 * it is called "… Email from Kristen 04.12.2026.pdf" — letting the filename
 * rules run first classified 572 files as approval emails, most of which were
 * documentation that happened to mention an email. The folder is the stronger
 * signal; the filename only decides within it.
 */
const BY_FOLDER: Record<string, ArtifactKind> = {
  "client ts": "client_timesheet",
  "daily total and daily clock in and clock out": "daily_punches",
  "driver timesheets": "driver_timesheet",
  "transaction batches": "transaction_batch_report",
  "payment batches": "payment_batch_report",
  "expert pay": "expert_pay",
  "bank feed": "bank_feed",
  documentation: "documentation",
  // ⚠️ `Holiday/` is NOT here on purpose. That folder holds the eligibility
  // reports AND the import file AND the work instructions, so the folder does
  // not determine the kind — the filenames there are specific enough.
};

/**
 * A numbered SOP: "2.3 Remove Driver Time", "1. Timesheet Template Send".
 * ⚠️ Also has to catch "3.1.1Troubleshooting…" — the real file has no space
 * after the number, which an anchored `\d+ ` pattern misses entirely.
 */
const NUMBERED_SOP = /^\d[\d ]*[a-z]/;

export type Classified = { kind: ArtifactKind; sensitive: boolean };

export function classifyArtifact(fileName: string, subfolder?: string | null): Classified {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (ext === "mp4") return { kind: "screen_recording", sensitive: false };

  const name = fold(fileName);
  const folder = fold(subfolder ?? "");

  // ⚠️ Expert Pay is checked FIRST and from BOTH sides. A file in that folder is
  // sensitive whatever it is called, and a file called that is sensitive
  // wherever it sits. Getting this wrong pushes raw SSNs into the app.
  if (folder === "expert pay" || /expert pay/.test(name)) {
    return { kind: "expert_pay", sensitive: true };
  }

  // An unambiguous folder beats any filename guess.
  const byFolder = BY_FOLDER[folder];
  if (byFolder) return { kind: byFolder, sensitive: SENSITIVE_KINDS.has(byFolder) };

  // Work instructions: numbered SOPs, "how to", "example of", "instructions".
  if (
    (ext === "docx" || ext === "doc") &&
    (NUMBERED_SOP.test(name) || /^example of|^how to |work instruction|instructions/.test(name))
  ) {
    return { kind: "work_instruction", sensitive: false };
  }
  if (/^example of/.test(name)) return { kind: "work_instruction", sensitive: false };

  for (const [re, kind] of RULES) {
    if (re.test(name)) return { kind, sensitive: SENSITIVE_KINDS.has(kind) };
  }

  // A bare "FOR IMPORT" with no other signal is still an import file.
  if (/for import/.test(name)) return { kind: "master_import", sensitive: false };
  if (/pay stub|paystub/.test(name)) return { kind: "documentation", sensitive: false };
  // Standing models that live beside the periods rather than inside one.
  if (/cost calculator|housing occupancy/.test(name)) {
    return { kind: "reference_analysis", sensitive: false };
  }

  return { kind: "unknown", sensitive: false };
}

/** Which stage of the week an artifact belongs to, for the board's ordering. */
export const KIND_STAGE: Record<ArtifactKind, string> = {
  master_export_raw: "Friday", master_export: "Friday", customer_template: "Friday",
  client_timesheet: "Monday", daily_punches: "Monday",
  master_import: "Monday", master_import_no_driver: "Monday",
  driver_timesheet: "Monday", driver_pay_units: "Tuesday",
  transaction_batch_report: "Tuesday",
  fringe_import: "Tuesday", deduction_import: "Tuesday",
  payment_batch_report: "Wednesday", bank_feed: "Wednesday",
  expert_pay: "Thursday", holiday_eligibility: "Per holiday",
  holiday_import: "Per holiday", changes_workbook: "Ongoing",
  documentation: "Ongoing", approval_email: "Ongoing", advance: "Off-cycle",
  void_or_correction: "Off-cycle", paycard: "Off-cycle",
  work_instruction: "Reference", reference_analysis: "Reference",
  screen_recording: "Reference", unknown: "Unclassified",
};
