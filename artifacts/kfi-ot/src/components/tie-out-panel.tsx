import { useCallback, useEffect, useState } from "react";

/**
 * The six tie-outs, rendered pass/fail instead of pasted pivot snips.
 *
 * A failure shows WHO and BY HOW MUCH, because "it does not balance" is not
 * actionable and "these four people" is. Running against Zenople costs two
 * vendor calls, so the panel shows the last stored run and only re-pulls when
 * asked.
 */

type TieOut = {
  tieOut: string;
  status: "pass" | "fail" | "not_run";
  scope: string | null;
  expected: string;
  actual: string;
  variance: string;
  detail: unknown;
};

type Payload = {
  ranAt?: string;
  fromCache?: boolean;
  counts?: { items: number; deductions: number; customers: number };
  results: TieOut[];
};

const base = import.meta.env.BASE_URL;

const LABEL: Record<string, string> = {
  pay_vs_bill_units: "Pay units vs bill units",
  master_vs_batch: "Master vs transaction batch",
  ot_without_40: "Overtime without 40 hours",
  fringe_vs_deductions: "Fringe vs deductions",
  retro_fringe_vs_offset: "Retro fringe vs offset",
  tax_vs_register: "Tax pivot vs register",
};

const parseDetail = (d: unknown): unknown[] => {
  if (Array.isArray(d)) return d;
  if (typeof d === "string") {
    try {
      const p: unknown = JSON.parse(d);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};

export function TieOutPanel({ payDate }: { payDate: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setRunning(refresh);
      setError(null);
      try {
        const r = await fetch(
          `${base}api/payroll-run/periods/${payDate}/tie-outs${refresh ? "?refresh=1" : ""}`,
          { credentials: "include" },
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `tie-outs ${r.status}`);
        }
        setData((await r.json()) as Payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not run the tie-outs");
      } finally {
        setRunning(false);
      }
    },
    [payDate],
  );

  useEffect(() => { void load(false); }, [load]);

  // Per-customer pay-vs-bill collapses to one line; the rest stand alone.
  const global = (data?.results ?? []).filter((r) => !r.scope);
  const scoped = (data?.results ?? []).filter((r) => r.scope);
  const scopedFails = scoped.filter((r) => r.status === "fail");

  return (
    <section className="rounded-lg bg-white shadow-sm ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-brand-navy">Tie-outs</h2>
        <div className="flex items-center gap-3">
          {data?.ranAt && (
            <span className="fin-num text-xs text-muted-foreground">
              {data.fromCache ? "last run " : "run "}
              {new Date(data.ranAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            disabled={running}
            onClick={() => void load(true)}
            className="rounded-md px-2 py-1 text-xs font-medium text-brand-navy ring-1 ring-border transition-colors hover:ring-brand-navy/30 disabled:opacity-50"
          >
            {running ? "Running…" : "Run against Zenople"}
          </button>
        </div>
      </div>

      {error && <p className="px-4 py-3 text-sm text-orange-800">{error}</p>}

      {!data && !error ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      ) : data && data.results.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Not run yet for this period.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {global.map((r) => {
            const detail = parseDetail(r.detail);
            return (
              <li key={r.tieOut} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {LABEL[r.tieOut] ?? r.tieOut}
                    </p>
                    <p className="fin-num mt-0.5 text-xs text-muted-foreground">
                      expected {r.expected} · actual {r.actual} · variance {r.variance}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                      r.status === "pass"
                        ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                        : "bg-orange-50 text-orange-700 ring-orange-600/25"
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                {detail.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {detail.slice(0, 8).map((d, i) => (
                      <li key={i} className="fin-num text-xs text-muted-foreground">
                        {describe(d)}
                      </li>
                    ))}
                    {detail.length > 8 && (
                      <li className="text-xs text-muted-foreground">
                        and {detail.length - 8} more
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}

          {scoped.length > 0 && (
            <li className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">By customer</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {scoped.length - scopedFails.length} of {scoped.length} customers clean
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                    scopedFails.length === 0
                      ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                      : "bg-orange-50 text-orange-700 ring-orange-600/25"
                  }`}
                >
                  {scopedFails.length === 0 ? "pass" : `${scopedFails.length} off`}
                </span>
              </div>
              {scopedFails.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {scopedFails.map((r) => (
                    <li key={r.scope} className="text-xs">
                      <span className="font-medium text-foreground">{r.scope}</span>
                      <ul className="mt-0.5 space-y-0.5">
                        {parseDetail(r.detail).map((d, i) => (
                          <li key={i} className="fin-num text-muted-foreground">
                            {describe(d)}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Render a detail row without dumping raw JSON at a payroll processor. */
function describe(d: unknown): string {
  if (typeof d !== "object" || d === null) return String(d);
  const o = d as Record<string, unknown>;
  if (typeof o.person === "string") {
    if (typeof o.reason === "string") {
      return `${o.person} — ${o.reason} (base ${String(o.base)}, OT ${String(o.ot)})`;
    }
    return `${o.person} — pay ${String(o.payHours)}h vs bill ${String(o.billHours)}h (${String(o.variance)}h)`;
  }
  if (typeof o.hint === "string") return o.hint;
  return JSON.stringify(d);
}
