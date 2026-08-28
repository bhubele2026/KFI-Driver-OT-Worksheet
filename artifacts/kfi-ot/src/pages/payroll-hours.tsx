import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";

/**
 * Hours Intake — Monday's per-customer board.
 *
 * ⚠️ The board states its own coverage. Zenople holds daily punch detail for
 * one customer; for the rest it can show week-level hours but the punch compare
 * still needs the emailed file. Showing 27 green rows for customers whose
 * punches nobody has looked at would be worse than showing nothing.
 */

type Customer = {
  customer: string;
  people: number;
  rtHours: number;
  otHours: number;
  timeSources: string[];
  batchesClosed: number;
  batchesOpen: number;
  hasDailyDetailInZenople: boolean;
  dailyPersonDays: number;
  longShifts: Array<{ personId: number; person: string | null; workDate: string; hours: number }>;
  punchCompare: string;
};

type Payload = {
  payDate: string;
  accountingPeriod: string;
  customers: Customer[];
  coverage: {
    customersWithZenopleDailyDetail: number;
    customersTotal: number;
    note: string;
  };
};

const base = import.meta.env.BASE_URL;

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

export default function PayrollHours() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${payDate}/hours-intake`, {
        credentials: "include",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `hours intake ${r.status}`);
      }
      setData((await r.json()) as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load the board");
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [payDate]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppShell active="/payroll-process/hours">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-brand-navy">Hours Intake</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {data ? `Accounting period ${data.accountingPeriod}` : "Monday's per-customer board."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Pay date
              <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)}
                className="fin-num rounded-md border border-border bg-white px-2 py-1 text-sm" />
            </label>
            <button type="button" disabled={busy} onClick={() => void load()}
              className="rounded-md px-2 py-1 text-xs font-medium text-brand-navy ring-1 ring-border transition-colors hover:ring-brand-navy/30 disabled:opacity-50">
              {busy ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        {data && (
          <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/25">
            <span className="font-medium">
              Daily punches in Zenople for {data.coverage.customersWithZenopleDailyDetail} of{" "}
              {data.coverage.customersTotal} customers.
            </span>{" "}
            {data.coverage.note}
          </div>
        )}

        {!data ? (
          !error && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <section className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-border">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 text-right font-medium">People</th>
                  <th className="px-3 py-2 text-right font-medium">RT</th>
                  <th className="px-3 py-2 text-right font-medium">OT</th>
                  <th className="px-3 py-2 font-medium">Time source</th>
                  <th className="px-3 py-2 font-medium">Batches</th>
                  <th className="px-3 py-2 font-medium">Punch compare</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.customers.map((c) => (
                  <tr key={c.customer}>
                    <td className="px-3 py-2 align-top font-medium text-foreground">{c.customer}</td>
                    <td className="fin-num px-3 py-2 text-right align-top">{c.people}</td>
                    <td className="fin-num px-3 py-2 text-right align-top">{c.rtHours}</td>
                    <td className="fin-num px-3 py-2 text-right align-top">{c.otHours}</td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                      {c.timeSources.join(", ") || "—"}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                      {c.batchesOpen > 0
                        ? <span className="text-amber-800">{c.batchesOpen} open</span>
                        : "all closed"}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {c.hasDailyDetailInZenople ? (
                        c.longShifts.length ? (
                          <div>
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-600/25">
                              {c.longShifts.length} over 13h
                            </span>
                            <ul className="mt-1 space-y-0.5">
                              {c.longShifts.slice(0, 4).map((s) => (
                                <li key={`${s.personId}-${s.workDate}`} className="fin-num text-xs text-muted-foreground">
                                  {s.person} — {s.workDate}, {s.hours}h
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20">
                            clean · {c.dailyPersonDays} person-days
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          needs the customer&rsquo;s punch file
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              A shift over 13 hours is almost always a missed clock-out recorded as 24, not a real
              shift. Trienda filters PREM from its punches before comparing; Penda does not.
            </p>
          </section>
        )}
      </div>
    </AppShell>
  );
}
