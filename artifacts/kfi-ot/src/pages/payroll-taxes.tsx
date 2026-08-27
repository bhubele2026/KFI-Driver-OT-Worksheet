import { PayrollSection } from "./payroll-section";

export default function PayrollTaxes() {
  return (
    <PayrollSection
      tileKey="payroll_taxes"
      href="/payroll-process/taxes"
      title="Taxes / APTM"
      intro="The daily tax pivot tied to the payroll register, and the upload clock."
      upcoming={[
        "Daily Tax Current pivot tied to the Payroll Register for both offices",
        "CSV prep traps as blocking checks: remove the header row, save as CSV, close the file",
        "The 4PM CST deadline as a visible clock",
        "Note the known blank-tax-code line (Yvon Agustin, WI resident, KY code not taxable)",
      ]}
    />
  );
}
