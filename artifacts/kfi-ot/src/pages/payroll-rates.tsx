import { PayrollSection } from "./payroll-section";

export default function PayrollRates() {
  return (
    <PayrollSection
      tileKey="payroll_rates"
      href="/payroll-process/rates"
      title="Rates & Terms"
      intro="Year-1 to Year-2 markups, terminations, deduction deactivations and pro-rate stops."
      upcoming={[
        "Y1 to Y2/Y3 markup changes, with the trap stated: changing markup at the job level does NOT propagate to assignments even though Zenople reports success",
        "Zenople-timekeeping customers additionally need update transactions on the existing timesheet",
        "Terminations from the Open Positions terminations tab",
        "Deduction deactivations for terms",
        "Carry pro-rate stops forward to the next period",
      ]}
    />
  );
}
