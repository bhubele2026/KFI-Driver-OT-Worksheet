import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";
import { CheckPanel, type CheckRow } from "@/components/check-panel";

/** Taxes / APTM — the upload with a deadline attached. */

const base = import.meta.env.BASE_URL;

type Status = {
  deadline: { deadlineCt: string; minutesRemaining: number; state: "ok" | "soon" | "past" };
  offices: string[];
  checks: CheckRow[];
};

const CSV_STEPS = [
  "Remove the header row — APTM errors on it",
  "Remove the trailing blank grey row",
  "Save as CSV, not xlsx — selecting the Excel file errors",
  "CLOSE the file — an open file will not upload",
];

export default function PayrollTaxes() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${base}api/payroll-run/aptm-status`, { credentials: "include" });
        if (!r.ok) throw new Error(`aptm ${r.status}`);
        if (alive) setStatus((await r.json()) as Status);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "could not read the clock");
      }
    };
    void tick();
    // The whole point of this tile is the deadline, so keep it honest.
    const id = setInterval(() => void tick(), 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const d = status?.deadline;
  const tone = d?.state === "past" ? "bg-orange-50 text-orange-800 ring-orange-600/25"
    : d?.state === "soon" ? "bg-amber-50 text-amber-900 ring-amber-600/25"
    : "bg-white text-brand-navy ring-border";

  return (
    <AppShell active="/payroll-process/taxes">
      <div className="rise-in space-y-5">
        <div>
          <Link href="/payroll-process"
            className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy">
            ← Payroll Process
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-brand-navy">Taxes / APTM</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The daily tax pivot tied to the register, and the upload clock.
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        <div className={`rounded-lg p-4 shadow-sm ring-1 ${tone}`}>
          <div className="text-xs uppercase tracking-wide opacity-70">Upload deadline</div>
          <div className="fin-num mt-1 text-2xl font-semibold">
            {d
              ? d.state === "past"
                ? `Past ${d.deadlineCt}`
                : `${Math.floor(d.minutesRemaining / 60)}h ${d.minutesRemaining % 60}m left`
              : "—"}
          </div>
          <div className="mt-1 text-sm opacity-80">
            {d ? `Cutoff ${d.deadlineCt}. Both offices upload separately.` : "Reading the clock…"}
          </div>
        </div>

        <CheckPanel title="APTM" checks={status?.checks ?? null}
          footer="The pivot total is employer PLUS employee tax. Comparing against either half alone always fails." />

        <section className="rounded-lg bg-white shadow-sm ring-1 ring-border">
          <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold text-brand-navy">
            Before uploading
          </h2>
          <ul className="divide-y divide-border">
            {CSV_STEPS.map((s) => (
              <li key={s} className="px-4 py-2.5 text-sm text-muted-foreground">{s}</li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-2.5 text-xs text-orange-800">
            If you cannot review the import straight away, set the file status from Valid to
            Check. That stops APTM pulling funds until someone has looked at it.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
