import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";
import { PayDatePicker } from "@/components/pay-date-picker";
import { Collapse, Caret, SkeletonStats, SkeletonTable } from "@/components/motion";

/**
 * Master Import — Monday afternoon.
 *
 * Two jobs that are done today by filtering a spreadsheet and deleting rows by
 * hand: pulling out everyone who reported no hours, and planning the driver
 * pay-unit removal.
 *
 * ⚠️ THIS BOARD SHOWS THE WORK, NOT A VERDICT ON IT. What it reads is Zenople's
 * own transaction rows, so it cannot tell you the assembled file is right —
 * comparing Zenople back to Zenople would be a green check that means nothing.
 * That comparison is tie-out 2, and it needs the file Tiana actually builds.
 */

type NoHoursPerson = {
  personId: number;
  person: string;
  customer: string;
  excludedFromEmail: boolean;
  excludeReason?: string;
};

type Named = { personId: number; name: string | null };

type Payload = {
  period: { payDate: string; accountingPeriod: string };
  counts: {
    rows: number; people: number; noHours: number;
    askOperations: number; drivers: number;
  };
  noHours: NoHoursPerson[];
  askOperations: NoHoursPerson[];
  removal: {
    matched: number[];
    expectedUnmatched: Array<{ personId: number; reason: string; name: string | null }>;
    unexpectedUnmatched: Named[];
    adjustments: Array<{ customer: string; driverRt: number; driverOt: number }>;
    totals: { driverRt: number; driverOt: number };
  };
};

const base = import.meta.env.BASE_URL;

/** Hours keep two decimals — the workbook and Zenople both carry them. */
const hrs = (n: number): string => n.toFixed(2);

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function Stat({ value, label, hint, tone }: {
  value: string; label: string; hint?: string; tone?: "ok" | "bad" | "warn";
}) {
  const colour = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-brand-navy";
  return (
    <div className="surface rounded-card px-4 py-3 ring-1 ring-brand-line">
      <p className="text-micro font-medium uppercase tracking-[0.08em] text-neutral-500">{label}</p>
      <p className={`fin-num mt-1 text-title font-semibold ${colour}`}>{value}</p>
      {hint && <p className="mt-0.5 text-micro text-neutral-500">{hint}</p>}
    </div>
  );
}

export default function PayrollMaster() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  // ⚠️ Ignore a superseded response — changing the pay date twice quickly can
  // let the first, slower reply land second and put one week's figures under
  // another week's heading. This board makes two Zenople pulls per load.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${payDate}/master-import`, {
        credentials: "include",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `master import ${r.status}`);
      }
      const payload = (await r.json()) as Payload;
      if (mine !== seq.current) return;
      setData(payload);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "could not load the board");
      setData(null);
    } finally {
      if (mine !== seq.current) return;
      setBusy(false);
    }
  }, [payDate]);

  useEffect(() => { void load(); }, [load]);

  const r = data?.removal;
  const unexpected = r?.unexpectedUnmatched ?? [];

  return (
    <AppShell active="/payroll-process/master">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="text-micro font-medium text-neutral-500 no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-brand-navy">Master Import</h1>
            <p className="mt-1 text-body text-neutral-500">
              {data
                ? `Accounting period ${data.period.accountingPeriod}`
                : "The no-hours list and the driver-time removal."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PayDatePicker value={payDate} onChange={setPayDate} />
            <button type="button" disabled={busy} onClick={() => void load()}
              className="press rounded-control px-2 py-1 text-micro font-medium text-brand-navy ring-1 ring-brand-line hover:ring-brand-navy/30 disabled:opacity-50">
              {busy ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        {error && (
          <div className="surface rounded-card p-4 text-body text-bad ring-1 ring-bad/30">{error}</div>
        )}

        {!data && !error && (
          <>
            <SkeletonStats n={4} />
            <SkeletonTable rows={6} cols={3} />
          </>
        )}

        {data && (
          <>
            <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
              <Stat value={String(data.counts.people)} label="People on the master"
                    hint={`${data.counts.rows} rows`} />
              <Stat value={String(data.counts.noHours)} label="Reported no hours"
                    hint="every row for them comes out"
                    tone={data.counts.noHours > 0 ? "warn" : undefined} />
              <Stat value={String(data.counts.askOperations)} label="Ask Operations"
                    hint={
                      data.counts.noHours !== data.counts.askOperations
                        ? `${data.counts.noHours - data.counts.askOperations} left off on purpose`
                        : "the no-hours email"
                    } />
              <Stat value={hrs((r?.totals.driverRt ?? 0) + (r?.totals.driverOt ?? 0))}
                    label="Driver hours coming out"
                    hint={`RT ${hrs(r?.totals.driverRt ?? 0)} · OT ${hrs(r?.totals.driverOt ?? 0)}`} />
            </div>

            {/*
              ⚠️ An unexpected unmatched driver is the ONLY thing on this board
              that is genuinely wrong, so it is the only thing that gets the bad
              colour. The four who never match are named and quiet.
            */}
            {unexpected.length > 0 && (
              <div className="surface rounded-card p-4 ring-1 ring-bad/30">
                <p className="text-body font-medium text-bad">
                  {unexpected.length} driver{unexpected.length === 1 ? "" : "s"} not on the master, and not expected to be missing
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {unexpected.map((d) => (
                    <li key={d.personId} className="fin-num text-micro text-neutral-500">
                      {d.name ?? "(name not on the roster)"} · {d.personId}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <section className="surface rounded-card ring-1 ring-brand-line">
              <div className="band flex items-center justify-between gap-2">
                <h2 className="text-label font-semibold text-brand-navy">Reported no hours</h2>
                <span className="text-micro text-neutral-500">
                  every row for these people comes out of the import
                </span>
              </div>
              {data.noHours.length === 0 ? (
                <p className="px-4 py-3 text-body text-neutral-500">
                  Everyone on the master reported hours.
                </p>
              ) : (
                <ul className="divide-y divide-brand-line">
                  {data.noHours.map((p) => (
                    <li key={p.personId} className="flex items-baseline justify-between gap-3 px-4 py-2">
                      <span className="min-w-0">
                        <span className="text-body text-foreground">{p.person}</span>
                        <span className="ml-2 text-micro text-neutral-500">{p.customer}</span>
                      </span>
                      {/*
                        Martin is left off the Operations email on purpose — he
                        is not billable, so asking about him every week is noise.
                        He still comes out of the import like anyone else, and
                        saying so is the difference between a rule and a gap.
                      */}
                      {p.excludedFromEmail && (
                        <span className="shrink-0 rounded-full bg-warn-bg px-2 py-0.5 text-micro font-medium text-warn ring-1 ring-warn/25"
                              title={p.excludeReason}>
                          not on the email
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="surface rounded-card ring-1 ring-brand-line">
              <div className="band flex items-center justify-between gap-2">
                <h2 className="text-label font-semibold text-brand-navy">Driver time to remove</h2>
                <span className="fin-num text-micro text-neutral-500">
                  RT {hrs(r?.totals.driverRt ?? 0)} · OT {hrs(r?.totals.driverOt ?? 0)}
                </span>
              </div>
              {(r?.adjustments.length ?? 0) === 0 ? (
                <p className="px-4 py-3 text-body text-neutral-500">
                  No driver pay units on this period&rsquo;s master.
                </p>
              ) : (
                <table className="w-full table-fixed">
                  <colgroup>
                    <col /><col className="w-28" /><col className="w-28" /><col className="w-28" />
                  </colgroup>
                  <thead>
                    <tr className="text-micro uppercase tracking-[0.08em] text-neutral-500">
                      <th className="px-4 py-2 text-left font-medium">Customer</th>
                      <th className="px-3 py-2 text-right font-medium">Driver RT</th>
                      <th className="px-3 py-2 text-right font-medium">Driver OT</th>
                      <th className="px-3 py-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-line">
                    {r!.adjustments.map((a) => (
                      <tr key={a.customer}>
                        <td className="px-4 py-2 text-body text-foreground">{a.customer}</td>
                        <td className="fin-num px-3 py-2 text-right text-body">{hrs(a.driverRt)}</td>
                        <td className="fin-num px-3 py-2 text-right text-body">{hrs(a.driverOt)}</td>
                        <td className="fin-num px-3 py-2 text-right text-body">
                          {hrs(a.driverRt + a.driverOt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/*
                    ⚠️ THE TOTAL ROW IS THE TIE. These per-customer figures are
                    the negative adjustment columns on the Timesheet processing
                    tab, and they have to add to the driver pivot's grand total
                    before anything is deleted. A table whose rows do not sum to
                    its own footer is how a wrong number survives a review.
                  */}
                  <tfoot>
                    <tr className="border-t border-brand-line">
                      <td className="px-4 py-2 text-body font-medium text-brand-navy">All customers</td>
                      <td className="fin-num px-3 py-2 text-right text-body font-medium">
                        {hrs(r!.totals.driverRt)}
                      </td>
                      <td className="fin-num px-3 py-2 text-right text-body font-medium">
                        {hrs(r!.totals.driverOt)}
                      </td>
                      <td className="fin-num px-3 py-2 text-right text-body font-medium">
                        {hrs(r!.totals.driverRt + r!.totals.driverOt)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </section>

            <section className="surface rounded-card ring-1 ring-brand-line">
              <div className="band">
                <button type="button" onClick={() => toggle("matching")}
                  aria-expanded={open.has("matching")}
                  className="press flex items-center gap-1.5 text-left">
                  <Caret open={open.has("matching")} />
                  <span className="text-label font-semibold text-brand-navy">
                    Driver matching — {r?.matched.length ?? 0} of {data.counts.drivers} on the master
                  </span>
                </button>
              </div>
              <Collapse open={open.has("matching")}>
                <div className="px-4 py-3">
                  <p className="text-body text-neutral-500">
                    These four never appear on the master, and that is expected rather than a
                    miss — three record their time in Zenople and one is not billable. Naming
                    them is the difference between a clean check and four unexplained gaps that
                    get shrugged at every week.
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {(r?.expectedUnmatched ?? []).map((e) => (
                      <li key={e.personId} className="text-micro text-neutral-500">
                        <span className="fin-num">{e.personId}</span> — {e.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              </Collapse>
            </section>

            <p className="text-micro text-neutral-500">
              The master&rsquo;s last three column headers carry leading spaces, and the import
              will not load without them. Anything that writes the file back out checks that
              before it writes.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
