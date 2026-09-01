import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";
import { PayDatePicker } from "@/components/pay-date-picker";
import { CheckPanel, type CheckRow } from "@/components/check-panel";

/**
 * Expert Pay — prepared and checked here, paid by a human.
 *
 * ⚠️ The file never reaches this page. It carries unmasked SSNs and stays on
 * the Mac; this works on the two dates and the totals a person reads off the
 * screen in front of them.
 */

type Dates = {
  payDate: string;
  effectiveDate: string;
  withholdingDate: string;
  exportNote: string;
  bank: string;
  artifacts: string[];
};

const base = import.meta.env.BASE_URL;

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const FORMAT_STEPS = [
  ["openedWithoutConverting", "Opened WITHOUT converting — converting strips leading zeros from the SSNs"],
  ["columnCZeroDecimals", "Column C to number format, 0 decimals"],
  ["ssnLeadingZerosIntact", "Column E leading zeros restored as text"],
  ["savedAfterFormatting", "Saved after formatting — an unsaved file will not upload"],
] as const;

export default function PayrollExpertPay() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [dates, setDates] = useState<Dates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckRow[] | null>(null);

  const [format, setFormat] = useState({
    openedWithoutConverting: false, columnCZeroDecimals: false,
    ssnLeadingZerosIntact: false, savedAfterFormatting: false,
  });
  const [effective, setEffective] = useState("");
  const [withholding, setWithholding] = useState("");
  const [bank, setBank] = useState("");
  const [csvTotal, setCsvTotal] = useState("");
  const [systemTotal, setSystemTotal] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      setError(null);
      try {
        const r = await fetch(`${base}api/payroll-run/periods/${payDate}/expert-pay`, {
          credentials: "include",
        });
        if (!r.ok) throw new Error(`expert pay ${r.status}`);
        if (alive) {
          const d = (await r.json()) as Dates;
          setDates(d);
          setChecks(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "could not load");
      }
    })();
    return () => { alive = false; };
  }, [payDate]);

  const verify = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${payDate}/expert-pay/verify`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format,
          enteredEffective: effective || undefined,
          enteredWithholding: withholding || undefined,
          bankAccount: bank || undefined,
          csvTotal: csvTotal === "" ? undefined : Number(csvTotal),
          systemTotal: systemTotal === "" ? undefined : Number(systemTotal),
        }),
      });
      if (!r.ok) throw new Error(`verify ${r.status}`);
      setChecks(((await r.json()) as { checks: CheckRow[] }).checks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not verify");
    }
  }, [payDate, format, effective, withholding, bank, csvTotal, systemTotal]);

  return (
    <AppShell active="/payroll-process/expert-pay">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-brand-navy">Expert Pay</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Child support. The file stays on your machine and the payment stays manual.
            </p>
          </div>
          <PayDatePicker value={payDate} onChange={setPayDate} />
        </div>

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        {dates && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              ["Effective date", dates.effectiveDate, "the Tuesday AFTER the pay date"],
              ["Withholding date", dates.withholdingDate, "the paycheck date itself"],
              ["Bank account", dates.bank, "not the operating account"],
            ].map(([k, v, sub]) => (
              <div key={String(k)} className="rounded-lg bg-white px-4 py-3 shadow-sm ring-1 ring-border">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="fin-num mt-0.5 text-lg font-semibold text-brand-navy">{v}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
              </div>
            ))}
          </div>
        )}

        {dates && (
          <p className="text-sm text-muted-foreground">
            Zenople export note: <span className="fin-num font-medium text-foreground">{dates.exportNote}</span>
          </p>
        )}

        <section className="rounded-lg bg-white shadow-sm ring-1 ring-border">
          <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold text-brand-navy">
            Before uploading
          </h2>
          <ul className="divide-y divide-border">
            {FORMAT_STEPS.map(([key, text]) => (
              <li key={key} className="flex items-start gap-3 px-4 py-2.5">
                <input type="checkbox" checked={format[key]}
                  onChange={(e) => setFormat((f) => ({ ...f, [key]: e.target.checked }))}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[var(--brand-navy,#0f2740)]" />
                <span className="text-sm text-muted-foreground">{text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-border">
          <h2 className="text-sm font-semibold text-brand-navy">What you typed into Expert Pay</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                { label: "Effective date", value: effective, set: setEffective, type: "date" },
                { label: "Withholding date", value: withholding, set: setWithholding, type: "date" },
                { label: "Bank account", value: bank, set: setBank, type: "text" },
                { label: "CSV total", value: csvTotal, set: setCsvTotal, type: "number" },
                { label: "System total", value: systemTotal, set: setSystemTotal, type: "number" },
              ] satisfies Array<{
                label: string;
                value: string;
                set: (v: string) => void;
                type: "date" | "text" | "number";
              }>
            ).map((f) => (
              <label key={f.label} className="block text-xs text-muted-foreground">
                {f.label}
                <input
                  type={f.type}
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  className="fin-num mt-1 block w-full rounded-md border border-border bg-white px-2 py-1 text-sm text-foreground"
                />
              </label>
            ))}
          </div>
          <button type="button" onClick={() => void verify()}
            className="mt-3 rounded-md bg-brand-navy px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90">
            Check before submitting
          </button>
        </section>

        <CheckPanel title="Pre-submit checks" checks={checks}
          emptyMessage="Fill in what you entered and check it before you submit."
          footer="We pay the fees, so the system total is expected to be slightly HIGHER than the file. Lower means payments are missing." />
      </div>
    </AppShell>
  );
}
