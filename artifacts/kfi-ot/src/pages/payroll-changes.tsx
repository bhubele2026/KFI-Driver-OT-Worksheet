import { PayrollSection } from "./payroll-section";

export default function PayrollChanges() {
  return (
    <PayrollSection
      tileKey="payroll_changes"
      href="/payroll-process/changes"
      title="Changes & Deductions"
      intro="Everything from payroll@ that must be keyed into Zenople before the pay date, as action rows."
      upcoming={[
        "Sweep payroll@ mailbox-wide by date so unfiled mail is caught too, not just the PD folder",
        "Take the LAST reply's number and show what it replaced \u2014 corrections are the norm, not the exception",
        "One row per action, not per email; split retro weeks onto their own rows",
        "Flag paired rows loudly \u2014 a positive entered without its negative overpays",
        "Pro-rate calculator: amount x days / 7, which can generate three rows for one person",
        "Generate the deduction import cleanly \u2014 today's tab ships live #REF! errors every week",
        "Keep a separate Needs a Decision list: a discussed intent is not an approval",
      ]}
    />
  );
}
