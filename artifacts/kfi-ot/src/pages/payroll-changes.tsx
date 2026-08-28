import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";

/**
 * Changes & Deductions — every action that must be keyed before the pay date.
 *
 * One row per ACTION, not per email. Three people named in one transportation
 * table are three rows; a thread corrected four times is one row carrying the
 * final number and what it replaced.
 */

type Change = {
  rowKey: string;
  customer: string | null;
  employee: string | null;
  peopleCount: number;
  route: string | null;
  changeType: string;
  amount: string | null;
  hours: string | null;
  weekEnding: string | null;
  effectiveDate: string | null;
  isRetro: boolean;
  action: string;
  supersedes: string | null;
  pairedWithRowKey: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  category: string | null;
  notes: string | null;
  decisionQuestion: string | null;
  decisionOwner: string | null;
  sweepState: string;
  enteredZenople: number;
  verifiedTs: number;
  verifiedPas: number;
  documentationSaved: number;
};

type Payload = {
  period: { label: string };
  actions: Change[];
  decisions: Change[];
  counts: {
    actions: number; decisions: number; complete: number; retro: number;
    paired: number; newSinceLastSweep: number; changedSinceLastSweep: number;
  };
};

const base = import.meta.env.BASE_URL;

const FIELDS = [
  ["enteredZenople", "Zenople"],
  ["verifiedTs", "TS"],
  ["verifiedPas", "PAS"],
  ["documentationSaved", "Docs"],
] as const;

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

export default function PayrollChanges() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ⚠️ Ignore a superseded response. Changing the pay date twice quickly can let
  // the FIRST, slower reply land after the second, putting one week's numbers
  // under another week's heading — several of these tiles make two Zenople
  // pulls per load, so it is likely rather than theoretical. In a payroll tool
  // somebody would read last week's figures believing they are this week's.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${payDate}/changes`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`changes ${r.status}`);
      const payload = (await r.json()) as Payload;
      // Checked AFTER the await resolves — the parse is a suspension point, so
      // a newer request can start during it and this one must not win.
      if (mine !== seq.current) return;
      setData(payload);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "could not load the changes");
      setData(null);
    }
  }, [payDate]);

  useEffect(() => { void load(); }, [load]);

  const patch = useCallback(
    async (row: Change, field: string, value: number) => {
      setBusy(row.rowKey + field);
      try {
        const r = await fetch(
          `${base}api/payroll-run/periods/${payDate}/changes/${row.rowKey}`,
          {
            method: "PATCH", credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [field]: value }),
          },
        );
        if (!r.ok) throw new Error(`save ${r.status}`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not save");
      } finally {
        setBusy(null);
      }
    },
    [payDate, load],
  );

  /** -1 is n/a; otherwise a count against the row's headcount. Cycle 0 → n → n/a. */
  const cycle = (cur: number, people: number): number =>
    cur === -1 ? 0 : cur >= Math.max(1, people) ? -1 : Math.max(1, people);

  const c = data?.counts;

  return (
    <AppShell active="/payroll-process/changes">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-brand-navy">Changes &amp; Deductions</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {data?.period.label ?? "Everything that must be keyed before the pay date."}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Pay date
            <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)}
              className="fin-num rounded-md border border-border bg-white px-2 py-1 text-sm" />
          </label>
        </div>

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        {c && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Actions", c.actions],
              ["Fully verified", `${c.complete} of ${c.actions}`],
              ["Retro rows", c.retro],
              ["Need a decision", c.decisions],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg bg-white px-3 py-2.5 shadow-sm ring-1 ring-border">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="fin-num mt-0.5 text-lg font-semibold text-brand-navy">{v}</div>
              </div>
            ))}
          </div>
        )}

        {c && (c.newSinceLastSweep > 0 || c.changedSinceLastSweep > 0) && (
          <p className="text-sm text-muted-foreground">
            Since the last sweep: {c.newSinceLastSweep} new, {c.changedSinceLastSweep} changed.
          </p>
        )}

        {!data ? (
          !error && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.actions.length === 0 ? (
          <div className="rounded-lg bg-white p-5 text-sm text-muted-foreground shadow-sm ring-1 ring-border">
            No action rows for this period yet. They arrive from the payroll@ sweep.
          </div>
        ) : (
          <section className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-border">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Employee</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Action to take</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Route</th>
                  {FIELDS.map(([, label]) => (
                    <th key={label} className="px-2 py-2 text-center font-medium">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.actions.map((r) => (
                  <tr key={r.rowKey} className={r.isRetro ? "bg-amber-50/40" : undefined}>
                    <td className="px-3 py-2 align-top text-muted-foreground">{r.customer}</td>
                    <td className="px-3 py-2 align-top">
                      {r.employee}
                      {r.peopleCount > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({r.peopleCount} people)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {r.changeType}
                      {r.isRetro && (
                        <span className="ml-1 rounded bg-amber-100 px-1 text-xs font-medium text-amber-800">
                          RETRO {r.weekEnding}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className="font-medium text-foreground">{r.action}</span>
                      {r.supersedes && (
                        <span className="mt-0.5 block text-xs text-orange-700">
                          Supersedes: {r.supersedes}
                        </span>
                      )}
                      {r.pairedWithRowKey && (
                        <span className="mt-0.5 block text-xs font-medium text-orange-700">
                          Paired — do not enter alone
                        </span>
                      )}
                      {r.notes && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">{r.notes}</span>
                      )}
                    </td>
                    <td className="fin-num px-3 py-2 text-right align-top">{r.hours ?? ""}</td>
                    <td className="fin-num px-3 py-2 text-right align-top">{r.amount ?? ""}</td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">{r.route}</td>
                    {FIELDS.map(([field]) => {
                      const v = r[field];
                      const done = v === -1 || v >= Math.max(1, r.peopleCount);
                      return (
                        <td key={field} className="px-2 py-2 text-center align-top">
                          <button
                            type="button"
                            disabled={busy === r.rowKey + field}
                            onClick={() => void patch(r, field, cycle(v, r.peopleCount))}
                            title={v === -1 ? "n/a" : `${v} of ${Math.max(1, r.peopleCount)}`}
                            className={`h-6 w-9 rounded text-xs font-medium ring-1 transition-colors ${
                              v === -1
                                ? "bg-zinc-100 text-zinc-500 ring-zinc-400/25"
                                : done
                                  ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                                  : "bg-white text-muted-foreground ring-border hover:ring-brand-navy/30"
                            }`}
                          >
                            {v === -1 ? "n/a" : `${v}/${Math.max(1, r.peopleCount)}`}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {data && data.decisions.length > 0 && (
          <section className="rounded-lg bg-white shadow-sm ring-1 ring-border">
            <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold text-brand-navy">
              Needs a decision — not on the action list
            </h2>
            <ul className="divide-y divide-border">
              {data.decisions.map((r) => (
                <li key={r.rowKey} className="px-4 py-3">
                  <p className="text-sm text-foreground">
                    {r.decisionQuestion ?? r.action}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {[r.customer, r.employee, r.decisionOwner && `ask ${r.decisionOwner}`]
                      .filter(Boolean).join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              A discussed intent is not an approval. These stay off the action list until answered.
            </p>
          </section>
        )}
      </div>
    </AppShell>
  );
}
