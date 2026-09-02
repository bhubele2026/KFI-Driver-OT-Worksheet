import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";
import { Caret, Collapse, Reveal, SkeletonStats, SkeletonTable } from "@/components/motion";
import { PayDatePicker } from "@/components/pay-date-picker";
import { useCountUp } from "@/hooks/use-count-up";
import { guardedFetch } from "@/lib/session";

/**
 * Changes & Deductions — every action that must be keyed before the pay date.
 *
 * One row per ACTION, not per email. Three people named in one transportation
 * table are three rows; a thread corrected four times is one row carrying the
 * final number and what it replaced.
 *
 * Presentation follows the dashboard's platinum language: navy and orange
 * only, sections as milled cards in the order the week runs, motion on the
 * shared dials. Status colours: navy = done, grey = not applicable, deep
 * orange = needs someone's attention.
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
  /** AI-terse row label; null when unavailable — the full action shows instead. */
  summary: string | null;
  /** Create-PDF lifecycle: null → requested → filed | failed. */
  pdfStatus: string | null;
  pdfRequestedAt: string | null;
  pdfWebUrl: string | null;
  pdfError: string | null;
  fileNaming: string | null;
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

type Field = (typeof FIELDS)[number][0];

/**
 * The board is worked in the order the week runs — Brad's framing: a pay rate
 * change hits earnings AND billing so it must land before invoicing; a housing
 * deduction only hits the check and belongs in Wednesday's PAS run. The route
 * comes from the server (Tiana's own "Pre or Post Time card" routing, learned
 * per change type); this list only says how to present it.
 */
const ROUTE_SECTIONS = [
  {
    key: "Ops", title: "Ops — Zenople housekeeping",
    doBy: "Before the Master export",
    long: "Zenople housekeeping that must be right before the Master export is assembled",
    preInvoice: true,
  },
  {
    key: "TMS", title: "TMS — transactions",
    doBy: "Mon–Tue · before batch close",
    long: "Earnings AND billing — must land before transaction batches close on Tuesday, or billing is at risk",
    preInvoice: true,
  },
  {
    key: "2TMS", title: "2TMS — round-2 import",
    doBy: "Tue · second import",
    long: "Earnings-side items that ride the round-2 import after the timecard",
    preInvoice: true,
  },
  {
    key: "PAS", title: "PAS — payroll module",
    doBy: "Wed · PAS run",
    long: "Check-only items — after invoicing, in Wednesday's PAS run",
    preInvoice: false,
  },
  {
    key: null, title: "Needs a route",
    doBy: "Route by hand",
    long: "Unrecognised change type — route it by hand before keying",
    preInvoice: false,
  },
] as const;

/**
 * ONE column grid for every section — the whole page shares its vertical
 * rules, the way a drawn sheet does. Browser auto-layout computes widths per
 * table from content, so five sections meant five different grids; `<colgroup>`
 * + table-fixed pins them all to this one. Widths live here and nowhere else.
 * The last verification column is wider by its own right padding so the chip
 * block ends flush with the band's px-5 margin.
 */
const COLS = (
  <colgroup>
    <col style={{ width: "13%" }} />
    <col style={{ width: "13%" }} />
    <col style={{ width: "11%" }} />
    <col />
    <col style={{ width: "4rem" }} />
    <col style={{ width: "5rem" }} />
    <col style={{ width: "3.5rem" }} />
    <col style={{ width: "3.5rem" }} />
    <col style={{ width: "3.5rem" }} />
    <col style={{ width: "4.25rem" }} />
  </colgroup>
);

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const rowDone = (r: Change, field: Field): boolean => {
  const v = r[field];
  return v === -1 || v >= Math.max(1, r.peopleCount);
};
const rowComplete = (r: Change): boolean => FIELDS.every(([f]) => rowDone(r, f));

/** One stat on the strip — count-up number, micro-caps label. */
function Stat({
  label, value, of, tone, index,
}: {
  label: string; value: number; of?: number; tone?: string; index: number;
}) {
  const n = useCountUp(value);
  return (
    <Reveal index={index} className="surface rounded-card p-4 ring-1 ring-brand-line">
      <div className="text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
        {label}
      </div>
      <div className={`fin-num mt-1 text-2xl font-semibold ${tone ?? "text-brand-navy"}`}>
        {Math.round(n)}
        {of != null && (
          <span className="ml-1 text-sm font-medium text-neutral-400">of {of}</span>
        )}
      </div>
    </Reveal>
  );
}

export default function PayrollChanges() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Rows whose detail drawer is open. The board leads with the terse label;
  // the full instruction, supersedes, pairing and provenance live one press
  // away — fewer words on the face, nothing lost.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // ⚠️ Ignore a superseded response. Changing the pay date twice quickly can let
  // the FIRST, slower reply land after the second, putting one week's numbers
  // under another week's heading. In a payroll tool somebody would read last
  // week's figures believing they are this week's.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const r = await guardedFetch(`${base}api/payroll-run/periods/${payDate}/changes`);
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

  // Summaries are generated in the background on the server's first sight of
  // a period; a cold load renders full text. Re-fetch ONCE, quietly, so the
  // terse labels arrive without anyone reloading. (load() is sequence-guarded
  // and replaces data in place — no flash.)
  const retriedForSummaries = useRef(false);
  useEffect(() => {
    if (!data || retriedForSummaries.current) return;
    if (data.actions.length === 0 || data.actions.some((a) => a.summary)) return;
    retriedForSummaries.current = true;
    const t = window.setTimeout(() => void load(), 8_000);
    return () => window.clearTimeout(t);
  }, [data, load]);

  /**
   * Optimistic: the tick lands on screen the frame it is clicked, the PATCH
   * follows, and a failure reverts by reloading the truth. The old flow
   * re-fetched the whole board on every tick, which read as a flash.
   */
  const patch = useCallback(
    async (row: Change, field: Field, value: number) => {
      setBusy(row.rowKey + field);
      setData((d) => {
        if (!d) return d;
        const actions = d.actions.map((r) =>
          r.rowKey === row.rowKey ? { ...r, [field]: value } : r,
        );
        return {
          ...d,
          actions,
          counts: { ...d.counts, complete: actions.filter(rowComplete).length },
        };
      });
      try {
        const r = await guardedFetch(
          `${base}api/payroll-run/periods/${payDate}/changes/${row.rowKey}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [field]: value }),
          },
        );
        if (!r.ok) throw new Error(`save ${r.status}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not save");
        await load();
      } finally {
        setBusy(null);
      }
    },
    [payDate, load],
  );

  /** -1 is n/a; otherwise a count against the row's headcount. Cycle 0 → n → n/a. */
  const cycle = (cur: number, people: number): number =>
    cur === -1 ? 0 : cur >= Math.max(1, people) ? -1 : Math.max(1, people);

  /**
   * Queue the row's source email for filing as a PDF. Optimistic like the
   * ticks: the chip flips to "requested" on the click, the POST follows, and
   * the executor's verdict (filed with a link, or failed with a reason)
   * arrives on the next load.
   */
  const requestPdf = useCallback(
    async (row: Change) => {
      setBusy(row.rowKey + "pdf");
      setData((d) => d && {
        ...d,
        actions: d.actions.map((r) =>
          r.rowKey === row.rowKey
            ? { ...r, pdfStatus: "requested", pdfError: null }
            : r,
        ),
      });
      try {
        const r = await guardedFetch(
          `${base}api/payroll-run/periods/${payDate}/changes/${row.rowKey}/pdf-request`,
          { method: "POST" },
        );
        if (!r.ok) throw new Error(`request ${r.status}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not request the PDF");
        await load();
      } finally {
        setBusy(null);
      }
    },
    [payDate, load],
  );

  const c = data?.counts;

  return (
    <AppShell active="/payroll-process/changes">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="press text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500 no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-display font-semibold tracking-tight text-brand-navy">
              Changes &amp; Deductions
            </h1>
            <p className="mt-1 text-body text-neutral-500">
              {data?.period.label ?? "Every change for the period, staged in the order the week runs."}
            </p>
          </div>
          <PayDatePicker value={payDate} onChange={setPayDate} />
        </div>

        {error && (
          <div className="rounded-card bg-bad-bg p-4 text-body text-bad ring-1 ring-bad/20">
            {error}
          </div>
        )}

        {c && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat index={0} label="Actions" value={c.actions} />
            <Stat index={1} label="Fully verified" value={c.complete} of={c.actions} />
            <Stat index={2} label="Retro rows" value={c.retro} />
            <Stat index={3} label="Need a decision" value={c.decisions}
              tone={c.decisions > 0 ? undefined : "text-neutral-400"} />
          </div>
        )}

        {c && (c.newSinceLastSweep > 0 || c.changedSinceLastSweep > 0) && (
          <p className="text-label text-neutral-500">
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-navy align-middle" aria-hidden />
            Updated by the latest sweep — {c.newSinceLastSweep} new, {c.changedSinceLastSweep} revised.
          </p>
        )}

        {!data ? (
          !error && (
            <div className="space-y-5">
              <SkeletonStats />
              <SkeletonTable rows={6} cols={6} />
              <SkeletonTable rows={4} cols={6} />
            </div>
          )
        ) : data.actions.length === 0 ? (
          <div className="surface rounded-card p-6 text-body text-neutral-500 ring-1 ring-brand-line">
            No action rows for this period yet. They arrive from the payroll inbox sweep.
          </div>
        ) : (
          <div className="space-y-5">
            {ROUTE_SECTIONS.map((sec, si) => {
              const rows = data.actions.filter((r) =>
                sec.key === null
                  ? !r.route || !ROUTE_SECTIONS.some((x) => x.key === r.route)
                  : r.route === sec.key);
              if (rows.length === 0) return null;
              const done = rows.filter(rowComplete).length;
              return (
                <Reveal key={sec.title} index={si}>
                  <section className="surface overflow-hidden rounded-card ring-1 ring-brand-line">
                    <div className="band flex items-center gap-x-3 px-5 py-3">
                      <h2 className="shrink-0 text-title font-semibold tracking-tight text-brand-navy">
                        {sec.title}
                      </h2>
                      {sec.preInvoice && (
                        <span className="shrink-0 rounded bg-brand-navy px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white shadow-rest">
                          Pre-invoice
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-label text-neutral-500" title={sec.long}>
                        {sec.doBy}
                      </span>
                      <span className="fin-num shrink-0 text-label text-neutral-500">
                        {done} of {rows.length} verified
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[62rem] table-fixed text-body">
                        {COLS}
                        <thead>
                          <tr className="border-b border-brand-line bg-brand-tint/70 text-left text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
                            <th className="py-2.5 pl-5 pr-3 font-semibold">Customer</th>
                            <th className="px-3 py-2.5 font-semibold">Employee</th>
                            <th className="px-3 py-2.5 font-semibold">Type</th>
                            <th className="px-3 py-2.5 font-semibold">Action to take</th>
                            <th className="px-3 py-2.5 text-right font-semibold">Hours</th>
                            <th className="px-3 py-2.5 text-right font-semibold">Amount</th>
                            {FIELDS.map(([, label], fi) => (
                              <th key={label}
                                className={`py-2.5 text-center font-semibold ${fi === FIELDS.length - 1 ? "pl-1 pr-3" : "px-1"}`}>
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => {
                            // Every row opens: even a bare one now carries the
                            // Create-PDF control (and its status) in the drawer.
                            const open = expanded.has(r.rowKey);
                            return (
                            <Fragment key={r.rowKey}>
                            <tr
                              className={`border-t border-brand-line/70 transition-colors duration-150 hover:bg-brand-tint/70 ${r.isRetro ? "bg-brand-wash/60" : ""}`}>
                              <td className="py-3 pl-5 pr-3 align-top text-neutral-500">{r.customer}</td>
                              <td className="px-3 py-3 align-top font-medium text-brand-ink">
                                {r.employee}
                                {r.peopleCount > 1 && (
                                  <span className="ml-1 text-micro font-normal text-neutral-400">
                                    ({r.peopleCount} people)
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-3 align-top text-neutral-500">
                                {r.changeType}
                                {r.isRetro && (
                                  <span className="mt-1 block w-max whitespace-nowrap rounded bg-brand-navy px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                                    Retro {r.weekEnding}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-3 align-top">
                                <button type="button" onClick={() => toggleRow(r.rowKey)}
                                  title={r.summary ? r.action : undefined}
                                  className="press flex w-full items-baseline gap-1.5 text-left">
                                  <Caret open={open} className="w-3 shrink-0 text-neutral-400" />
                                  <span className="font-medium text-brand-ink">{r.summary ?? r.action}</span>
                                </button>
                              </td>
                              <td className="fin-num px-3 py-3 text-right align-top text-brand-ink">{r.hours ?? ""}</td>
                              <td className="fin-num px-3 py-3 text-right align-top text-brand-ink">{r.amount ?? ""}</td>
                              {FIELDS.map(([field]) => {
                                const v = r[field];
                                const done2 = rowDone(r, field);
                                return (
                                  <td key={field}
                                    className={`py-2 text-center align-top ${field === "documentationSaved" ? "pl-1 pr-3" : "px-1"}`}>
                                    <button
                                      type="button"
                                      disabled={busy === r.rowKey + field}
                                      onClick={() => void patch(r, field, cycle(v, r.peopleCount))}
                                      title={v === -1 ? "n/a" : `${v} of ${Math.max(1, r.peopleCount)}`}
                                      className={`press h-6 w-9 rounded text-micro font-semibold ring-1 ${
                                        v === -1
                                          ? "bg-warn-bg text-warn ring-transparent"
                                          : done2
                                            ? "bg-brand-navy text-white ring-brand-navy"
                                            : "bg-white text-brand-navy ring-brand-navy/25 hover:ring-brand-navy/60"
                                      }`}
                                    >
                                      {v === -1 ? "n/a" : `${v}/${Math.max(1, r.peopleCount)}`}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                            <tr aria-hidden={!open}>
                              <td colSpan={10} className="p-0">
                                <Collapse open={open}>
                                  <div className="space-y-1.5 bg-brand-tint/60 py-3 pl-[3.25rem] pr-5 text-label">
                                    {r.summary && r.summary !== r.action && (
                                      <p className="text-brand-ink">{r.action}</p>
                                    )}
                                    {r.supersedes && (
                                      <p className="font-semibold text-brand-navy">
                                        Supersedes: {r.supersedes}
                                      </p>
                                    )}
                                    {r.pairedWithRowKey && (
                                      <p className="font-semibold text-brand-navy">
                                        Paired — do not enter alone
                                      </p>
                                    )}
                                    {r.notes && <p className="text-neutral-500">{r.notes}</p>}
                                    {(r.requestedBy || r.approvedBy) && (
                                      <p className="text-micro text-neutral-500">
                                        {[
                                          r.requestedBy && `Requested by ${r.requestedBy}`,
                                          r.approvedBy && `Approved by ${r.approvedBy}`,
                                        ].filter(Boolean).join(" · ")}
                                      </p>
                                    )}
                                    <div className="flex flex-wrap items-center gap-2 pt-1">
                                      {r.pdfStatus === "filed" && r.pdfWebUrl ? (
                                        <>
                                          <a href={r.pdfWebUrl} target="_blank" rel="noreferrer"
                                            className="press rounded bg-brand-navy px-2 py-1 text-micro font-semibold text-white no-underline shadow-rest">
                                            PDF filed — open
                                          </a>
                                          {r.fileNaming && (
                                            <span className="text-micro text-neutral-500">{r.fileNaming}</span>
                                          )}
                                        </>
                                      ) : r.pdfStatus === "requested" ? (
                                        <span
                                          className="rounded bg-warn-bg px-2 py-1 text-micro font-semibold text-warn"
                                          title="Files on the executor's next pass — usually within 15 minutes.">
                                          PDF requested
                                        </span>
                                      ) : r.pdfStatus === "failed" ? (
                                        <>
                                          <span className="rounded bg-bad-bg px-2 py-1 text-micro font-semibold text-bad">
                                            PDF failed{r.pdfError ? ` — ${r.pdfError}` : ""}
                                          </span>
                                          <button type="button" disabled={busy === r.rowKey + "pdf"}
                                            onClick={() => void requestPdf(r)}
                                            className="press rounded bg-white px-2 py-1 text-micro font-semibold text-brand-navy ring-1 ring-brand-navy/25 hover:ring-brand-navy/60">
                                            Retry
                                          </button>
                                        </>
                                      ) : (
                                        <button type="button" disabled={busy === r.rowKey + "pdf"}
                                          onClick={() => void requestPdf(r)}
                                          title="Files the source email as a PDF in SharePoint › New PDF"
                                          className="press rounded bg-white px-2 py-1 text-micro font-semibold text-brand-navy ring-1 ring-brand-navy/25 hover:ring-brand-navy/60">
                                          Create PDF
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </Collapse>
                              </td>
                            </tr>
                            </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </Reveal>
              );
            })}
          </div>
        )}

        {data && data.decisions.length > 0 && (
          <Reveal index={5}>
            <section className="surface overflow-hidden rounded-card ring-1 ring-brand-line">
              <div className="band flex items-center gap-3 px-5 py-3">
                <h2 className="text-title font-semibold tracking-tight text-brand-navy">
                  Needs a decision
                </h2>
                <span className="fin-num rounded-full bg-brand-wash px-2 py-0.5 text-micro font-semibold text-brand-navy">
                  {data.decisions.length}
                </span>
                <span className="text-label text-neutral-500">Held off the action list</span>
              </div>
              <ul className="divide-y divide-brand-line/70">
                {data.decisions.map((r) => (
                  <li key={r.rowKey} className="px-5 py-3 transition-colors duration-150 hover:bg-brand-tint/70">
                    <p className="text-body text-brand-ink">
                      {r.decisionQuestion ?? r.action}
                    </p>
                    <p className="mt-0.5 text-micro text-neutral-500">
                      {[r.customer, r.employee, r.decisionOwner && `ask ${r.decisionOwner}`]
                        .filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="border-t border-brand-line px-5 py-2.5 text-micro text-neutral-500">
                Discussed is not approved — these stay here until answered.
              </p>
            </section>
          </Reveal>
        )}
      </div>
    </AppShell>
  );
}
