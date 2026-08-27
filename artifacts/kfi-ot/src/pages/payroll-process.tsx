import { AppShell } from "@/components/app-shell";

/**
 * Payroll Process — the landing spot for the payroll run itself.
 * Deliberately empty for now: app bar, heading, nothing else.
 */
export default function PayrollProcess() {
  return (
    <AppShell active="/payroll-process">
      <div className="rise-in space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Payroll Process</h1>
        </div>
      </div>
    </AppShell>
  );
}
