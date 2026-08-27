import { PayrollSection } from "./payroll-section";

export default function PayrollOffCycle() {
  return (
    <PayrollSection
      tileKey="payroll_off_cycle"
      href="/payroll-process/off-cycle"
      title="Off-Cycle"
      intro="Advances, voids and reissues \u2014 a different entity from the weekly run, not a variant of it."
      upcoming={[
        "Disbursement channel as a real field: ACH, Walmart e-card, Walmart physical card, Venmo, live check",
        "The universal quad: approval PDF, transaction batch report, payment batch report, and a bank file or a recorded reason there is not one",
        "Void and reissue as a first-class state, including a correction between two people",
        "Rapid paycard deactivation tracking, which appears in no process document today",
      ]}
    />
  );
}
