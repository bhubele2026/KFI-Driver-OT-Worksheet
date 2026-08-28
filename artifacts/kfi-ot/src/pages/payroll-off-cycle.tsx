import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";

/**
 * Off-Cycle — advances, voids and reissues.
 *
 * A different entity from the weekly run, not a variant of it. The column that
 * matters is the disbursement channel: a missing bank file is NORMAL for a
 * Walmart card and ALARMING for an ACH, and only the channel says which.
 */

type Run = {
  periodId: number;
  payDate: string;
  label: string;
  files: number;
  inferredChannel: string | null;
  hasApproval: boolean;
  hasTransactionBatchReport: boolean;
  hasPaymentBatchReport: boolean;
  hasBankFile: boolean;
  isAdvance: boolean;
  hasVoidOrCorrection: boolean;
};

type Payload = {
  channels: Array<{ key: string; label: string; producesBankFile: boolean }>;
  runs: Run[];
};

const base = import.meta.env.BASE_URL;

function Tick({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ring-1 ${
      ok ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
         : "bg-orange-50 text-orange-700 ring-orange-600/25"
    }`}>
      {label}
    </span>
  );
}

export default function PayrollOffCycle() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`${base}api/payroll-run/off-cycle`, { credentials: "include" });
        if (!r.ok) throw new Error(`off-cycle ${r.status}`);
        if (alive) setData((await r.json()) as Payload);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "could not load off-cycle runs");
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <AppShell active="/payroll-process/off-cycle">
      <div className="rise-in space-y-5">
        <div>
          <Link href="/payroll-process"
            className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy">
            ← Payroll Process
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-brand-navy">Off-Cycle</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Advances, voids and reissues — event-triggered, and mostly advances.
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        {data && (
          <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-border">
            <h2 className="text-sm font-semibold text-brand-navy">Disbursement channels</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              A missing bank file is normal for some of these and alarming for others.
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {data.channels.map((c) => (
                <li key={c.key}
                  className="rounded-full bg-zinc-50 px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-border">
                  {c.label}
                  <span className="ml-1.5 opacity-70">
                    {c.producesBankFile ? "bank file" : "no bank file"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!data ? (
          !error && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.runs.length === 0 ? (
          <div className="rounded-lg bg-white p-5 text-sm text-muted-foreground shadow-sm ring-1 ring-border">
            No off-cycle runs recorded yet. They appear once the bridge has inventoried their
            folders.
          </div>
        ) : (
          <section className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-border">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Run</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 text-right font-medium">Files</th>
                  <th className="px-3 py-2 font-medium">The quad</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.runs.map((r) => {
                  const channel = data.channels.find((c) => c.key === r.inferredChannel);
                  const bankFileExpected = channel?.producesBankFile ?? true;
                  return (
                    <tr key={r.periodId}>
                      <td className="px-3 py-2 align-top font-medium text-foreground">{r.label}</td>
                      <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                        {channel?.label ?? (
                          <span className="text-amber-800">not recorded</span>
                        )}
                      </td>
                      <td className="fin-num px-3 py-2 text-right align-top">{r.files}</td>
                      <td className="px-3 py-2 align-top">
                        <div className="flex flex-wrap gap-1">
                          <Tick ok={r.hasApproval} label="approval" />
                          <Tick ok={r.hasTransactionBatchReport} label="txn batch" />
                          <Tick ok={r.hasPaymentBatchReport} label="pay batch" />
                          <Tick ok={r.hasBankFile || !bankFileExpected}
                            label={r.hasBankFile ? "bank file" : "no bank file"} />
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                        {[r.isAdvance && "advance", r.hasVoidOrCorrection && "void/correction"]
                          .filter(Boolean).join(" · ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              Channels shown here are inferred from filenames for historical runs. New runs record
              it as a field. An advance is a loan — it needs a payback scheduled.
            </p>
          </section>
        )}
      </div>
    </AppShell>
  );
}
