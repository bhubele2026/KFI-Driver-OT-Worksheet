/**
 * The payroll checklist, seeded from the source of truth.
 *
 * ⚠️ This is NOT transcribed from the `Processes/` SOP folder. It is lifted
 * from the **`Checklist` tab of `Payroll changes for PD MM.DD.YYYY.xlsx`**,
 * which is the real specification for the weekly run — the SOP documents the
 * same work but is explicitly marked "Incomplete" at steps 2.3, 2.5, 3.1.1,
 * 4.1 and 5.1, which are the very steps most worth automating.
 *
 * 52 steps: 36 top-level and 16 subtasks, Friday through Friday. Six rows on
 * the tab carry no day of their own; they inherit the day of the row above,
 * and that inheritance is resolved here rather than left to the reader.
 *
 * `key` is stable and referenced by `payroll_step_state` — never renumber it.
 * `ordinal` is spaced by ten so a step can be inserted without a migration.
 */
export type PayrollStepSeed = {
  key: string;
  ordinal: number;
  day: string;
  parent: string | null;
  tile: string;
  task: string;
};

export const PAYROLL_CHECKLIST: readonly PayrollStepSeed[] = [
  { key: "timesheets_templates_sent", ordinal: 10, day: "Friday",
    parent: null, tile: "templates",
    task: "Timesheets Templates sent" },
  { key: "process_timesheets_and_hours_sent_via_email_by_clien", ordinal: 20, day: "Monday",
    parent: null, tile: "hours_intake",
    task: "Process 'timesheets' and hours sent via email by client" },
  { key: "save_daily_clock_in_and_clock_out_files", ordinal: 30, day: "Monday",
    parent: "process_timesheets_and_hours_sent_via_email_by_clien", tile: "hours_intake",
    task: "Save Daily clock in and clock out files" },
  { key: "compare_at_least_two_individuals_on_each_daily_clock", ordinal: 40, day: "Monday",
    parent: "process_timesheets_and_hours_sent_via_email_by_clien", tile: "hours_intake",
    task: "Compare at least two individuals on each Daily Clock in and clock out files to 'timesheet' file" },
  { key: "save_original_timesheet_file_provided_by_client", ordinal: 50, day: "Monday",
    parent: "process_timesheets_and_hours_sent_via_email_by_clien", tile: "hours_intake",
    task: "Save original Timesheet file provided by client" },
  { key: "compare_timesheet_file_provided_by_client_to_templat", ordinal: 60, day: "Monday",
    parent: "process_timesheets_and_hours_sent_via_email_by_clien", tile: "hours_intake",
    task: "compare Timesheet file provided by client to template for import" },
  { key: "master_import_file_created", ordinal: 70, day: "Monday",
    parent: null, tile: "master_import",
    task: "Master import file created" },
  { key: "no_hours_email", ordinal: 80, day: "Monday",
    parent: null, tile: "master_import",
    task: "No hours email" },
  { key: "people_with_no_hours_removed_from_import_file", ordinal: 90, day: "Monday",
    parent: null, tile: "master_import",
    task: "People with no hours removed from Import file" },
  { key: "check_addresses_for_shusters_employees", ordinal: 100, day: "Monday",
    parent: null, tile: "master_import",
    task: "CHECK ADDRESSES FOR SHUSTERS EMPLOYEES" },
  { key: "checks_on_master_import_file", ordinal: 110, day: "Monday",
    parent: null, tile: "master_import",
    task: "Checks on Master Import file" },
  { key: "pay_units_match_bill_units_for_each_customer", ordinal: 120, day: "Monday",
    parent: "checks_on_master_import_file", tile: "master_import",
    task: "Pay Units match bill units for each customer" },
  { key: "pay_units_ot_and_rt_match_numbers_on_timesheet_proce", ordinal: 130, day: "Monday",
    parent: "checks_on_master_import_file", tile: "master_import",
    task: "Pay units OT and RT match numbers on timesheet processing tab for each customer" },
  { key: "ot_check_to_make_sure_there_are_no_people_who_are_ge", ordinal: 140, day: "Monday",
    parent: "checks_on_master_import_file", tile: "master_import",
    task: "OT Check to make sure there are no people who are getting paid OT who don't have 40 hours worked" },
  { key: "driver_pay_units_removed_from_master_import_file", ordinal: 150, day: "Monday",
    parent: null, tile: "master_import",
    task: "Driver Pay units removed from Master import file" },
  { key: "master_import_file_imported", ordinal: 160, day: "Monday/Tuesday",
    parent: null, tile: "master_import",
    task: "Master Import file imported" },
  { key: "tms_billable_items_added_retro_pay_expense_reimburse", ordinal: 170, day: "Monday/Tuesday",
    parent: null, tile: "master_import",
    task: "TMS Billable items added (retro pay, expense reimbursements (that are billable)" },
  { key: "transaction_batches_created", ordinal: 180, day: "Tuesday",
    parent: null, tile: "batches",
    task: "Transaction batches created" },
  { key: "check_each_batch_as_you_save_it_to_ensure_rt_and_ot", ordinal: 190, day: "Tuesday",
    parent: "transaction_batches_created", tile: "batches",
    task: "Check each batch as you save it to ensure RT and OT hours match the Timesheet processing tab" },
  { key: "check_driver_time_and_customer_time_for_any_customer", ordinal: 200, day: "Tuesday",
    parent: null, tile: "driver_ot",
    task: "Check driver time and customer time for any customers who use Zenople time prior to closing those batches (currently Shusters only)" },
  { key: "let_alex_and_controller_know_when_the_batches_are_re", ordinal: 210, day: "Tuesday",
    parent: null, tile: "batches",
    task: "Let Alex and Controller know when the batches are ready to invoice" },
  { key: "master_overtime_file_updated_and_email_with_question", ordinal: 220, day: "Tuesday",
    parent: null, tile: "changes",
    task: "Master Overtime file updated and email with questions sent to Valerie" },
  { key: "fringe_file_created", ordinal: 230, day: "Tuesday/Wednesday",
    parent: null, tile: "fringe",
    task: "Fringe file created" },
  { key: "make_sure_to_remove_people_who_have_no_hours_reporte", ordinal: 240, day: "Tuesday/Wednesday",
    parent: "fringe_file_created", tile: "master_import",
    task: "Make sure to remove people who have no hours reported" },
  { key: "driver_calculations_completed", ordinal: 250, day: "Tuesday/Wednesday",
    parent: null, tile: "driver_ot",
    task: "Driver Calculations completed" },
  { key: "fringe_file_imported_and_transaction_batch_saved", ordinal: 260, day: "Tuesday/Wednesday",
    parent: null, tile: "fringe",
    task: "Fringe file imported and transaction batch saved" },
  { key: "driver_file_imported", ordinal: 270, day: "Tuesday/Wednesday",
    parent: null, tile: "driver_ot",
    task: "Driver File imported" },
  { key: "mn_esst_when_reviewing_make_sure_that_their_worked_h", ordinal: 280, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "MN ESST when reviewing make sure that their worked hours and MN ESST hours make sense (unless it is for a previous week)" },
  { key: "all_boxes_checked", ordinal: 290, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "All boxes checked" },
  { key: "all_documentation_saved", ordinal: 300, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "All documentation saved" },
  { key: "any_unresolved_items_moved_to_next_payroll_changes_f", ordinal: 310, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "Any unresolved items moved to next Payroll changes file" },
  { key: "documentation_email_and_to_this_payroll_cross_check", ordinal: 320, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "Documentation/Email and To this Payroll cross check" },
  { key: "payroll_summary_report_reviewed", ordinal: 330, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "Payroll Summary report reviewed" },
  { key: "check_to_see_if_any_live_checks", ordinal: 340, day: "Wednesday/Thursday",
    parent: "payroll_summary_report_reviewed", tile: "payroll_batch",
    task: "Check to see if any live checks" },
  { key: "review_total_hours_paid", ordinal: 350, day: "Wednesday/Thursday",
    parent: "payroll_summary_report_reviewed", tile: "payroll_batch",
    task: "Review total hours paid" },
  { key: "review_outliers_payments_under_under_300_or_over_200", ordinal: 360, day: "Wednesday/Thursday",
    parent: "payroll_summary_report_reviewed", tile: "payroll_batch",
    task: "Review outliers (payments under under 300 or over 2000)" },
  { key: "check_the_taxes_being_withheld_especially_pennsylvan", ordinal: 370, day: "Wednesday/Thursday",
    parent: "payroll_summary_report_reviewed", tile: "payroll_batch",
    task: "Check the taxes being withheld (especially Pennsylvannia) to make sure that they are correct" },
  { key: "payroll_batch_report_balanced", ordinal: 380, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "Payroll batch report balanced" },
  { key: "check_to_make_sure_that_housing_supplemental_earning", ordinal: 390, day: "Wednesday/Thursday",
    parent: "payroll_batch_report_balanced", tile: "fringe",
    task: "Check to make sure that Housing Supplemental Earnings is exactly the same as TBD3 Fringe Deductions" },
  { key: "bank_feed_created_and_controller_notified", ordinal: 400, day: "Wednesday/Thursday",
    parent: null, tile: "payroll_batch",
    task: "Bank feed created and Controller notified" },
  { key: "run_daily_tax_report", ordinal: 410, day: "Wednesday/Thursday",
    parent: null, tile: "taxes_aptm",
    task: "Run Daily tax report" },
  { key: "tie_out_pivot_table_to_payroll_register_report", ordinal: 420, day: "Wednesday/Thursday",
    parent: "run_daily_tax_report", tile: "taxes_aptm",
    task: "Tie out pivot table to Payroll Register report" },
  { key: "let_controller_know_when_the_file_has_been_uploaded", ordinal: 430, day: "Wednesday/Thursday",
    parent: null, tile: "taxes_aptm",
    task: "Let Controller know when the file has been uploaded" },
  { key: "aptm_file_uploaded", ordinal: 440, day: "Wednesday/Thursday",
    parent: null, tile: "taxes_aptm",
    task: "APTM file uploaded" },
  { key: "tie_out_upload_to_payroll_register_report_pivot_tabl", ordinal: 450, day: "Wednesday/Thursday",
    parent: "aptm_file_uploaded", tile: "taxes_aptm",
    task: "Tie out upload to Payroll register report/pivot table" },
  { key: "make_sure_that_the_driver_power_bi_report_was_receiv", ordinal: 460, day: "Thursday",
    parent: null, tile: "driver_ot",
    task: "Make sure that the driver Power BI report was received" },
  { key: "expert_pay_processed", ordinal: 470, day: "Thursday/Friday",
    parent: null, tile: "expert_pay",
    task: "Expert Pay Processed" },
  { key: "let_controller_know_when_the_payment_has_been_proces", ordinal: 480, day: "Thursday/Friday",
    parent: null, tile: "expert_pay",
    task: "Let Controller know when the payment has been processed" },
  { key: "updated_y1y2_bill_rates", ordinal: 490, day: "Thursday/Friday",
    parent: null, tile: "rates_terms",
    task: "Updated Y1Y2 bill rates" },
  { key: "termination_of_assignments_from_open_positions_termi", ordinal: 500, day: "Thursday/Friday",
    parent: null, tile: "rates_terms",
    task: "Termination of assignments from Open positions Terminations tab" },
  { key: "deactivation_of_deductions_for_terms", ordinal: 510, day: "Thursday/Friday",
    parent: null, tile: "rates_terms",
    task: "Deactivation of Deductions for terms" },
  { key: "filter_for_and_copy_any_employees_who_are_stopping_h", ordinal: 520, day: "Thursday/Friday",
    parent: null, tile: "rates_terms",
    task: "Filter for and copy any employees who are stopping housing or transportation that were pro rated on this check to the next payroll changes spreadsheet" },
] as const;

/** Steps an off-cycle period actually runs. Off-cycle has no timesheet stage,
 *  no changes workbook and no Expert Pay — it is a different entity, not a
 *  variant, so it opts IN to the few steps it shares. */
export const OFF_CYCLE_STEP_KEYS: ReadonlySet<string> = new Set([
  "transaction_batches_created",
  "payroll_batch_report_balanced",
  "bank_feed_created_and_controller_notified",
  "all_documentation_saved",
]);

/**
 * The STAGES of the payroll week, in the workbook's own vocabulary.
 *
 * ⚠️ THESE ARE NOT TILE KEYS, AND THEY ARE NOT THE REGISTRY'S. The board
 * registry in `tiles.ts` also exports a `PAYROLL_TILE_KEYS`; that one is the
 * set of grantable boards (`payroll_master`, `payroll_hours`, …). This one is
 * the set of stages a checklist step belongs to. Two different things under
 * one name is exactly how the bug below shipped, so this is named for what it
 * is. Translate with `STAGE_TO_BOARD` — never compare a stage to a tile key.
 */
export const PAYROLL_STAGE_KEYS = [
  "payroll_run", "templates", "hours_intake", "master_import", "driver_ot",
  "batches", "fringe", "payroll_batch", "taxes_aptm", "expert_pay",
  "rates_terms", "changes",
] as const;
export type PayrollStageKey = (typeof PAYROLL_STAGE_KEYS)[number];

/**
 * Which board shows a stage's steps.
 *
 * ⚠️⚠️ THE BUG THIS EXISTS TO KILL. The four `<PayrollSection>` boards
 * (Templates, Master Import, Rates & Terms, Holiday) filtered the checklist
 * with `step.tile === "payroll_master"` while the seeds said `master_import`.
 * Nothing matched, so all four boards rendered "No checklist steps belong to
 * this tile" from the day they shipped — which is most of what "the level of
 * detail is not done" looked like on screen. The two vocabularies were never
 * connected and nothing tested the join; `payrollChecklistTiles.test.ts` does
 * now.
 *
 * The mapping is deliberately many-to-one. The workbook names more stages than
 * there are boards, and that is correct — the workbook is the richer document.
 *
 *  - `batches` (transaction batches, Tuesday) → Hours Intake, which is where
 *    the per-customer open/closed batch counts already are.
 *  - `driver_ot` → `timesheets`, the driver worksheet. Driver calculations and
 *    the driver file happen there, not on a payroll board, and `driver_ot` was
 *    never a tile in the registry at all.
 *  - `payroll_run` → the Payroll Process spine.
 */
export const STAGE_TO_BOARD: Readonly<Record<PayrollStageKey, string>> = {
  payroll_run: "payroll_process",
  templates: "payroll_templates",
  hours_intake: "payroll_hours",
  master_import: "payroll_master",
  driver_ot: "timesheets",
  batches: "payroll_hours",
  fringe: "payroll_fringe",
  payroll_batch: "payroll_batch",
  taxes_aptm: "payroll_taxes",
  expert_pay: "payroll_expert_pay",
  rates_terms: "payroll_rates",
  changes: "payroll_changes",
};

/**
 * The spine. It shows EVERY step, not one stage's worth, so it is never
 * filtered by `boardTile` and never expects steps to be routed to it.
 * `payroll_run` exists as a stage for completeness; no seed uses it today.
 */
export const SPINE_BOARD = "payroll_process";

/**
 * Boards that legitimately own no checklist step.
 *
 * Holiday pay is driven by a holiday date, not by the weekly run; off-cycle is
 * a different entity entirely; housing notes arrive from the Housing app. They
 * are listed so the test can tell "has no steps on purpose" from "its steps
 * stopped matching", which is the failure that went unseen before.
 */
export const BOARDS_WITHOUT_STEPS: ReadonlySet<string> = new Set([
  "payroll_holiday", "payroll_off_cycle", "payroll_housing_notes",
]);

/**
 * The board a step belongs on, or null if its stage is unknown or absent.
 *
 * Takes `string | null` because `payroll_steps.tile` is a nullable column: a
 * row seeded before a stage existed, or one deactivated after a rename, must
 * answer "no board" rather than throw on the checklist's hottest path.
 */
export function boardForStage(stage: string | null | undefined): string | null {
  if (!stage) return null;
  return STAGE_TO_BOARD[stage as PayrollStageKey] ?? null;
}
