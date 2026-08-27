import { PayrollSection } from "./payroll-section";

export default function PayrollFringe() {
  return (
    <PayrollSection
      tileKey="payroll_fringe"
      href="/payroll-process/fringe"
      title="Fringe"
      intro="Housing Benefit Supplemental against TBD3 deductions \u2014 the balance that has to be exact."
      upcoming={[
        "Build from the master filtered to Housing Benefit Supplemental and Cell Reimburse, pay unit 1",
        "Drop no-hours people except those housed free in a slow week, who carry to next week",
        "Pro-rate fringe whenever the housing deduction is pro-rated, and move the offset with it",
        "The balance is a hard gate: positive means missing deductions, negative means missing earnings",
        "Reconcile retro fringe against the retro offset",
      ]}
    />
  );
}
