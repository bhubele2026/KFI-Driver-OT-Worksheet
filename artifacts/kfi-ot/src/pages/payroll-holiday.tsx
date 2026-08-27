import { PayrollSection } from "./payroll-section";

export default function PayrollHoliday() {
  return (
    <PayrollSection
      tileKey="payroll_holiday"
      href="/payroll-process/holiday"
      title="Holiday Pay"
      intro="The 26-week eligibility look-back, computed rather than pivoted by hand."
      upcoming={[
        "Look-back of 26 calendar weeks before the week the holiday falls in",
        "Eligibility: at least 26 unique check dates and at least 720 worked hours, excluding holiday and PTO",
        "De-duplicate void and reversal checks per check date before counting",
        "Require an active assignment, and drop anyone who quit before the check date",
        "Build the import: Holiday Pay code, pay unit 1, pay rate 50, every bill column 0",
      ]}
    />
  );
}
