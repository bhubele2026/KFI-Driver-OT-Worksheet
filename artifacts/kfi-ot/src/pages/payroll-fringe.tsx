import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";

/**
 * Fringe — the balance that has to be exact.
 *
 * Reports per person as well as in total, because a variance of 69.23 means one
 * person and naming them is the whole job. A total alone sends someone back to
 * a spreadsheet to find out who.
 */

type Pairing = {
  earnCode: string;
  dedCode: string;
  earnings: string;
  deductions: string;
  variance: string;
  balanced: boolean;
  earningPeople: number;
  deductionPeople: number;
  sign: string | null;
  mismatches: Array<{
    personId: number; person: string; earning: string;
    deduction: string; variance: string; hint: string;
  }>;
};

type Payload = { payDate: string; accountingPeriod: string; current: Pairing; retro: Pairing };

const base = import.meta.env.BASE_URL;

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function Pair({ title, p }: { title: string; p: Pairing }) {
  return (
    <section className="rounded-lg bg-white shadow-sm ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-brand-navy">{title}</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
          p.balanced
            ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
            : "bg-orange-50 text-orange-700 ring-orange-600/25"
        }`}>
          {p.balanced ? "balanced" : `off by ${p.variance}`}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-px bg-border">
        {[
          ["Earnings", p.earnings, `${p.earningPeople} people`],
          ["Deductions", p.deductions, `${p.deductionPeople} people`],
          ["Variance", p.variance, p.sign ?? "exact"],
        ].map(([k, v, sub]) => (
          <div key={String(k)} className="bg-white px-4 py-3">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="fin-num mt-0.5 text-lg font-semibold text-brand-navy">{v}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
          </div>
        ))}
      </div>

      {p.mismatches.length > 0 && (
        <>
          <h3 className="border-t border-border px-4 py-2 text-xs font-medium text-muted-foreground">
            Who is off
          </h3>
          <ul className="divide-y divide-border">
            {p.mismatches.map((m) => (
              <li key={m.personId} className="flex items-baseline justify-between gap-3 px-4 py-2">
                <div className="min-w-0">
                  <span className="text-sm text-foreground">{m.person}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{m.hint}</span>
                </div>
                <span className="fin-num shrink-0 text-sm text-muted-foreground">
                  {m.earning} vs {m.deduction}
                  <span className="ml-2 font-medium text-orange-700">{m.variance}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default function PayrollFringe() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${payDate}/fringe`, {
        credentials: "include",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `fringe ${r.status}`);
      }
      setData((await r.json()) as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not run the reconciliation");
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [payDate]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppShell active="/payroll-process/fringe">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-brand-navy">Fringe</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Housing Benefit Supplemental against its offsetting deduction. This one has to be
              exact to the cent.
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
              {busy ? "Running…" : "Re-run"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        {!data ? (
          !error && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <Pair title="Housing fringe" p={data.current} />
            <Pair title="Retro housing fringe" p={data.retro} />
            <p className="text-xs text-muted-foreground">
              A positive variance means missing deductions; a negative one means missing earnings.
              Pro-rating the rent without pro-rating the fringe is the usual cause.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
