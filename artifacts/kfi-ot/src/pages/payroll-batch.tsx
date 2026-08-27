import { PayrollSection } from "./payroll-section";

export default function PayrollBatchPage() {
  return (
    <PayrollSection
      tileKey="payroll_batch"
      href="/payroll-process/batch"
      title="Payroll Batch"
      intro="Wednesday's checks on the register before anything is paid."
      upcoming={[
        "Register balance, and the documented out-of-balance hunt for the exact off-by amount",
        "Outliers under $300 or over $2,000",
        "Live check detection straight from the register",
        "MN ESST sanity: worked hours and ESST hours have to make sense together",
        "Pennsylvania withholding check",
      ]}
    />
  );
}
