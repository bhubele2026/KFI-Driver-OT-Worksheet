import { PayrollSection } from "./payroll-section";

export default function PayrollExpertPay() {
  return (
    <PayrollSection
      tileKey="payroll_expert_pay"
      href="/payroll-process/expert-pay"
      title="Expert Pay"
      intro="Child support export and totals check. The payment stays manual, and the file stays local."
      upcoming={[
        "Export and totals compare against the register",
        "Format traps: do not convert on open, column C to 0-decimal, column E SSNs with leading zeros restored",
        "Effective date is the Tuesday after the pay date; withholding date is the paycheck date; bank is Bank 7",
        "The CSV holds unmasked SSNs \u2014 it is prepared and filed locally and never pushed to this app",
        "The stored credential for this system needs rotating and stripping from the SOP document",
      ]}
    />
  );
}
