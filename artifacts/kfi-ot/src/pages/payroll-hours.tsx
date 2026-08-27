import { PayrollSection } from "./payroll-section";

export default function PayrollHours() {
  return (
    <PayrollSection
      tileKey="payroll_hours"
      href="/payroll-process/hours"
      title="Hours Intake"
      intro="Monday's per-customer board: hours in, punches compared, and each customer's own quirks."
      upcoming={[
        "Per-customer status flags with hour tie-outs against the daily punches",
        "Punch-vs-timesheet compare, now that daily punches are available from the Zenople API",
        "Trienda filters PREM from daily punches; Penda does not",
        "AT Owatonna needs a name concat and a pivot on payable codes only",
        "LSI divides dollars by hours to catch Year-1-vs-Year-2 markup errors",
        "Guard: nobody over 13 hours on a punch report \u2014 a missed clock records as a 24-hour shift",
        "Guard: Client TS files carry a column-shift trap where header index does not match data index",
      ]}
    />
  );
}
