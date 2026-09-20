import { useCallback, useEffect, useState } from "react";
import { Collapse, Caret } from "./motion";

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
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

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
    <section className="surface rounded-card ring-1 ring-brand-line">
      <div className="band flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-label font-semibold text-brand-navy">Tie-outs</h2>
        <div className="flex items-center gap-3">
          {data?.ranAt && (
            <span className="fin-num text-micro text-neutral-500">
              {data.fromCache ? "last run " : "run "}
              {new Date(data.ranAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            disabled={running}
            onClick={() => void load(true)}
            className="press rounded-control px-2 py-1 text-micro font-medium text-brand-navy ring-1 ring-brand-line hover:ring-brand-navy/30 disabled:opacity-50"
          >
            {running ? "Running…" : "Run against Zenople"}
          </button>
        </div>
      </div>

      {error && <p className="px-4 py-3 text-body text-bad">{error}</p>}

      {!data && !error ? (
        <p className="px-4 py-3 text-body text-neutral-500">Loading…</p>
      ) : data && data.results.length === 0 ? (
        <p className="px-4 py-3 text-body text-neutral-500">
          Not run yet for this period.
        </p>
      ) : (
        <ul className="divide-y divide-brand-line">
          {global.map((r) => {
            const detail = parseDetail(r.detail);
            const isOpen = open.has(r.tieOut);
            return (
              <li key={r.tieOut} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {detail.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggle(r.tieOut)}
                        aria-expanded={isOpen}
                        className="press -ml-1 flex items-center gap-1.5 rounded-control px-1 text-left"
                      >
                        <Caret open={isOpen} />
                        <span className="text-body font-medium text-foreground">
                          {LABEL[r.tieOut] ?? r.tieOut}
                        </span>
                        <span className="text-micro text-neutral-500">
                          {detail.length} {detail.length === 1 ? "row" : "rows"}
                        </span>
                      </button>
                    ) : (
                      <p className="text-body font-medium text-foreground">
                        {LABEL[r.tieOut] ?? r.tieOut}
                      </p>
                    )}
                    {/*
                      ⚠️ A VARIANCE PRINTS TO THE PENNY. Tie-out 4 has to be
                      EXACT, and the workbook's own sign convention — positive
                      means missing deductions, negative means missing earnings
                      — is only readable at full precision. "$2" instead of
                      "$1.92" is the difference between a number you can chase
                      and one you cannot.
                    */}
                    <p className="fin-num mt-0.5 text-micro text-neutral-500">
                      expected {r.expected} · actual {r.actual} · variance {r.variance}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-micro font-medium ring-1 ${
                      r.status === "pass"
                        ? "bg-ok-bg text-ok ring-ok/20"
                        : "bg-bad-bg text-bad ring-bad/30"
                    }`}
                  >
                    {r.status === "pass" ? "ties" : "off"}
                  </span>
                </div>
                {detail.length > 0 && (
                  <Collapse open={isOpen}>
                    <ul className="mt-2 space-y-0.5 pb-1">
                      {detail.map((d, i) => (
                        <li key={i} className="fin-num text-micro text-neutral-500">
                          {describe(d)}
                        </li>
                      ))}
                    </ul>
                  </Collapse>
                )}
              </li>
            );
          })}

          {scoped.length > 0 && (
            <li className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => toggle("__by_customer")}
                  aria-expanded={open.has("__by_customer")}
                  className="press -ml-1 min-w-0 rounded-control px-1 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    <Caret open={open.has("__by_customer")} />
                    <span className="text-body font-medium text-foreground">By customer</span>
                  </span>
                  <span className="mt-0.5 block pl-5 text-micro text-neutral-500">
                    {scoped.length - scopedFails.length} of {scoped.length} customers clean
                  </span>
                </button>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-micro font-medium ring-1 ${
                    scopedFails.length === 0
                      ? "bg-ok-bg text-ok ring-ok/20"
                      : "bg-bad-bg text-bad ring-bad/30"
                  }`}
                >
                  {scopedFails.length === 0 ? "ties" : `${scopedFails.length} off`}
                </span>
              </div>
              {/*
                Opens to EVERY customer, not only the failing ones. "17 of 20
                clean" is a claim about all twenty, and the three people who use
                this board are the ones who have to answer for the other
                seventeen — a clean customer you cannot open is a customer you
                have to take on trust.
              */}
              <Collapse open={open.has("__by_customer")}>
                <ul className="mt-2 space-y-1.5 pb-1">
                  {scoped.map((r) => {
                    const rows = parseDetail(r.detail);
                    const clean = r.status === "pass";
                    return (
                      <li key={r.scope} className="text-micro">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-foreground">{r.scope}</span>
                          <span className={`fin-num ${clean ? "text-neutral-500" : "text-bad"}`}>
                            {clean ? "ties" : r.variance}
                          </span>
                        </span>
                        {rows.length > 0 && (
                          <ul className="mt-0.5 space-y-0.5">
                            {rows.map((d, i) => (
                              <li key={i} className="fin-num text-neutral-500">
                                {describe(d)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Collapse>
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
