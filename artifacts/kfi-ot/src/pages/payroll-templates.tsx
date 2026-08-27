import { PayrollSection } from "./payroll-section";

export default function PayrollTemplates() {
  return (
    <PayrollSection
      tileKey="payroll_templates"
      href="/payroll-process/templates"
      title="Templates"
      intro="Friday's per-customer timesheet templates \u2014 split from the master export, sent, and tracked."
      upcoming={[
        "Split the Master External export into per-customer templates with exact naming",
        "Track which customers have been sent and which have replied",
        "The four email bodies, including the 11:30 chaser with a noon deadline",
        "Surface the precondition: pay and bill rate changes must be entered first",
        "Skip customers who keep time in Zenople \u2014 Alamco, Bell Lumber and Shusters get no template",
      ]}
    />
  );
}
