import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";
import { CheckPanel, type CheckRow } from "@/components/check-panel";

/**
 * Payroll Batch — Wednesday's review of the register, before anything is paid.
 *
 * Deliberately not cached: this reads the register as it stands right now, and
 * a stale "no live checks" would be worse than no answer.
 */

const base = import.meta.env.BASE_URL;

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

export default function PayrollBatchPage() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [checks, setChecks] = useState<CheckRow[] | null>(null);
  const [found, setFound] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ⚠️ Ignore a superseded response. Changing the pay date twice quickly can let
  // the FIRST, slower reply land after the second, putting one week's numbers
  // under another week's heading — several of these tiles make two Zenople
  // pulls per load, so it is likely rather than theoretical. In a payroll tool
  // somebody would read last week's figures believing they are this week's.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    setChecks(null);
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${payDate}/batch-checks`, {
        credentials: "include",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `batch checks ${r.status}`);
      }
      const d = (await r.json()) as { checks: CheckRow[]; found: number };
      if (mine !== seq.current) return;
      setChecks(d.checks);
      setFound(d.found);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "could not run the checks");
    } finally {
      if (mine !== seq.current) return;
      setBusy(false);
    }
  }, [payDate]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppShell active="/payroll-process/batch">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-brand-navy">Payroll Batch</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The last checks with a human in front of them.
              {found !== null && found > 0 ? ` ${found} payments on the register.` : ""}
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

        <CheckPanel
          title="Register checks"
          checks={error ? [] : checks}
          emptyMessage="No checks returned."
          footer="Outliers are worth a look, not a block — a part week is legitimately under $300 and a heavy overtime week legitimately over $2,000."
        />
      </div>
    </AppShell>
  );
}
