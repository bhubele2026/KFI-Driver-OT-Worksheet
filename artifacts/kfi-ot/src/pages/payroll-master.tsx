import { PayrollSection } from "./payroll-section";

export default function PayrollMaster() {
  return (
    <PayrollSection
      tileKey="payroll_master"
      href="/payroll-process/master"
      title="Master Import"
      intro="Assemble the master file, run the tie-outs, and work the no-hours list."
      upcoming={[
        "Assemble from the raw Zenople export \u2014 the original download CSV is the true source",
        "Render the tie-outs pass/fail instead of pasting pivot snips",
        "No-hours extraction to the follow-up list and the operations email; remove Martin (2003940)",
        "Driver-time removal, naming the four PersonIds that legitimately never match so they do not read as errors",
        "Preserve the leading spaces in the ' End Date', ' Status' and ' Assignment Id' headers on write",
      ]}
    />
  );
}
