import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";
import { Caret, Collapse, Reveal, SkeletonStats, SkeletonTable } from "@/components/motion";
import { PayDatePicker } from "@/components/pay-date-picker";
import { useCountUp } from "@/hooks/use-count-up";
import { guardedFetch } from "@/lib/session";

/**
 * Housing & Transport Notes — changes the housing team filed by hand.
 *
 * Brad, 2026-09-16: *"The goal is to put changes in that are discussed,
 * something that cannot be done auto."* A coordinator picks a person in the
 * Housing app, it fills in where that person is, she says what payroll must do
 * and types what happened. It arrives here as a task for the period.
 *
 * Presentation is the Changes board's, deliberately: same platinum language,
 * same sections in the order the week runs, same motion dials. Two boards that
 * do the same kind of work should not look like two different apps.
 */

type Rate = { rtPayRate: string | null; driverRtPayRate: string | null };

type Note = {
  noteKey: string;
  personId: number;
  personName: string;
  ask: string;
  askLabel: string;
  changeType: string | null;
  route: string | null;
  note: string;
  customer: string | null;
  shift: string | null;
  propertyName: string | null;
  roomLabel: string | null;
  bedLabel: string | null;
  vanLabel: string | null;
  vanRole: string | null;
  weeklyRent: string | null;
  deducted: string | null;
  deductedWeek: string | null;
  payWeekEnd: string;
  byEmail: string | null;
  notedAt: string | null;
  voidedAt: string | null;
  handledAt: string | null;
  handledBy: string | null;
  handledNote: string | null;
  rate: Rate | null;
};

type Payload = {
  period: { label: string };
  notes: Note[];
  /** null means Housing has never reached us — different from "none this week". */
  housingLastFiledAt: string | null;
  counts: { notes: number; handled: number; waiting: number; retracted: number };
};

const base = import.meta.env.BASE_URL;

/**
 * The same five sections as the Changes board, in the same order — Zenople
 * housekeeping before the Master export, transactions before Tuesday's batch
 * close, the round-2 import, then Wednesday's PAS run. The server decides which
 * one a note lands in (from the ask); this only says how to present it.
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
    long: "Earnings AND billing — must land before transaction batches close on Tuesday",
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
    long: "The coordinator picked “something else” — read it and route it before keying",
    preInvoice: false,
  },
] as const;

/**
 * ONE column grid for every section, so the whole page shares its vertical
 * rules the way a drawn sheet does. Browser auto-layout sizes each table from
 * its own content, which is five sections and five different grids.
 */
const COLS = (
  <colgroup>
    <col style={{ width: "13%" }} />
    {/* ⚠️ WIDE ENOUGH FOR THE BED, not merely truncating onto a tooltip. At 18% the
        house cut at "1402 8th St E house · rm4 · …" — and the room and bed are the
        part somebody keys in from. "What to do" below is flexible and has the slack. */}
    <col style={{ width: "24%" }} />
    <col style={{ width: "6rem" }} />
    <col style={{ width: "5rem" }} />
    <col style={{ width: "6rem" }} />
    <col />
    <col style={{ width: "8rem" }} />
    <col style={{ width: "6rem" }} />
  </colgroup>
);
const COL_COUNT = 8;

function upcomingFriday(): string {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const money = (v: string | null): string =>
  v == null ? "" : `$${Number(v).toFixed(2)}`;

const dayTime = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
};

/** Where this person was when the note was written — a snapshot, not today. */
function placeWords(r: Note): string {
  const bed = [r.propertyName, r.roomLabel, r.bedLabel].filter(Boolean).join(" · ");
  const van = r.vanLabel ? `${r.vanLabel}${r.vanRole ? ` (${r.vanRole})` : ""}` : "";
  return [bed, van].filter(Boolean).join(" — ");
}

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

export default function PayrollHousingNotes() {
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // ⚠️ Ignore a superseded response. Stepping the period twice quickly can let
  // the FIRST, slower reply land after the second, putting one week's tasks
  // under another week's heading — and somebody would work last week's list
  // believing it is this week's.
  const seq = useRef(0);
  const loading = useRef(false);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const mine = ++seq.current;
    setError(null);
    try {
      const r = await guardedFetch(`${base}api/payroll-run/periods/${payDate}/housing-notes`);
      if (!r.ok) throw new Error(`housing notes ${r.status}`);
      const payload = (await r.json()) as Payload;
      // Checked AFTER the await resolves — the parse is a suspension point, so
      // a newer request can start during it and this one must not win.
      if (mine !== seq.current) return;
      setData(payload);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "could not load the notes");
      setData(null);
    } finally {
      loading.current = false;
    }
  }, [payDate]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Tick one handled, or un-tick it. Optimistic, reverting by reloading truth
   * rather than by guessing what the server would have said.
   */
  const setHandled = async (r: Note, handled: boolean) => {
    setBusy(r.noteKey);
    const before = data;
    setData((d) => d && {
      ...d,
      notes: d.notes.map((n) => n.noteKey === r.noteKey
        ? { ...n, handledAt: handled ? new Date().toISOString() : null }
        : n),
    });
    try {
      const res = await guardedFetch(
        `${base}api/payroll-run/periods/${payDate}/housing-notes/${r.noteKey}/handled`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handled }),
        },
      );
      if (!res.ok) throw new Error(String(res.status));
      await load();
    } catch {
      setData(before);
      setError("that did not save — nothing changed");
    } finally {
      setBusy(null);
    }
  };

  const c = data?.counts;
  const live = (data?.notes ?? []).filter((n) => n.voidedAt === null);
  const retracted = (data?.notes ?? []).filter((n) => n.voidedAt !== null);

  return (
    <AppShell active="/payroll-process/housing-notes">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/payroll-process"
              className="press text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500 no-underline hover:text-brand-navy">
              ← Payroll Process
            </Link>
            <h1 className="mt-1 text-display font-semibold tracking-tight text-brand-navy">
              Housing &amp; Transport Notes
            </h1>
            <p className="mt-1 text-body text-neutral-500">
              {data?.period.label
                ? `${data.period.label} — filed by the housing team, for you to key in.`
                : "Changes the housing team filed by hand, for the period."}
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
            <Stat index={0} label="Notes" value={c.notes} />
            <Stat index={1} label="Handled" value={c.handled} of={c.notes} />
            <Stat index={2} label="Still to do" value={c.waiting}
              tone={c.waiting > 0 ? undefined : "text-neutral-400"} />
            <Stat index={3} label="Retracted" value={c.retracted}
              tone={c.retracted > 0 ? undefined : "text-neutral-400"} />
          </div>
        )}

        {!data ? (
          !error && (
            <div className="space-y-5">
              <SkeletonStats />
              <SkeletonTable rows={5} cols={6} />
            </div>
          )
        ) : live.length === 0 ? (
          /* ⚠️ "Nothing this week" and "the housing app has never reached us"
             are different facts, and a board that shows one sentence for both
             hides an outage behind a quiet week. */
          <div className="surface rounded-card p-6 text-body text-neutral-500 ring-1 ring-brand-line">
            {data.housingLastFiledAt === null
              ? "Nothing has ever been filed from the housing app. If that is a surprise, the connection between the two apps is the thing to check."
              : `No notes for this period. The housing team last filed something on ${dayTime(data.housingLastFiledAt)}.`}
          </div>
        ) : (
          <div className="space-y-5">
            {ROUTE_SECTIONS.map((sec, si) => {
              const rows = live.filter((r) =>
                sec.key === null
                  ? !r.route || !ROUTE_SECTIONS.some((x) => x.key === r.route)
                  : r.route === sec.key);
              if (rows.length === 0) return null;
              const done = rows.filter((r) => r.handledAt !== null).length;
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
                        {done} of {rows.length} handled
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[64rem] table-fixed text-body">
                        {COLS}
                        <thead>
                          <tr className="border-b border-brand-line bg-brand-tint/70 text-left text-micro font-semibold uppercase tracking-[0.08em] text-neutral-500">
                            <th className="py-2.5 pl-5 pr-3 font-semibold">Person</th>
                            <th className="px-3 py-2.5 font-semibold">Where they were</th>
                            <th className="px-3 py-2.5 text-right font-semibold">Rate</th>
                            <th className="px-3 py-2.5 text-right font-semibold">Rent</th>
                            <th className="px-3 py-2.5 text-right font-semibold">Deducting</th>
                            <th className="px-3 py-2.5 font-semibold">What to do</th>
                            <th className="px-3 py-2.5 font-semibold">Filed by</th>
                            <th className="py-2.5 pl-3 pr-5 text-center font-semibold">Handled</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => {
                            const open = expanded.has(r.noteKey);
                            const place = placeWords(r);
                            const rate = r.rate?.driverRtPayRate ?? r.rate?.rtPayRate ?? null;
                            const isDone = r.handledAt !== null;
                            return (
                              <Fragment key={r.noteKey}>
                                <tr className="border-t border-brand-line/70 transition-colors duration-150 hover:bg-brand-tint/70">
                                  <td className="py-3 pl-5 pr-3 align-top">
                                    <span className="font-medium text-brand-ink">{r.personName}</span>
                                    {r.customer && (
                                      <span className="mt-0.5 block truncate text-micro text-neutral-500" title={r.customer}>
                                        {r.customer}
                                      </span>
                                    )}
                                  </td>
                                  <td className="truncate px-3 py-3 align-top text-neutral-500" title={place || undefined}>
                                    {place || (
                                      <span className="text-micro" title="They were neither in one of our beds nor on a van when this was written.">
                                        not housed, no van
                                      </span>
                                    )}
                                  </td>
                                  <td className="fin-num px-3 py-3 text-right align-top text-brand-ink">
                                    {rate != null ? `$${Number(rate).toFixed(2)}` : (
                                      /* ⚠️ Words, never a dash or a zero. This app profiles
                                         drivers for the Zenople export and nobody else, so a
                                         housed non-driver genuinely has no rate here — and a
                                         blank cell on a pay screen reads as $0.00. */
                                      <span className="text-micro font-normal text-neutral-400"
                                        title="No rate on file in this app — it profiles drivers for the Zenople export, so most housed people have none.">
                                        no rate
                                      </span>
                                    )}
                                  </td>
                                  <td className="fin-num px-3 py-3 text-right align-top text-brand-ink">
                                    {money(r.weeklyRent)}
                                  </td>
                                  <td className="fin-num px-3 py-3 text-right align-top text-brand-ink"
                                    title={r.deductedWeek ? `As of the pay week ending ${r.deductedWeek}` : undefined}>
                                    {money(r.deducted)}
                                  </td>
                                  <td className="px-3 py-3 align-top">
                                    <button type="button" onClick={() => toggleRow(r.noteKey)}
                                      title={r.note}
                                      className="press flex w-full items-baseline gap-1.5 text-left">
                                      <Caret open={open} className="w-3 shrink-0 text-neutral-400" />
                                      <span className="min-w-0">
                                        <span className="font-medium text-brand-ink">{r.askLabel}</span>
                                        <span className="mt-0.5 block truncate text-micro text-neutral-500">
                                          {r.note}
                                        </span>
                                      </span>
                                    </button>
                                  </td>
                                  <td className="truncate px-3 py-3 align-top text-micro text-neutral-500"
                                    title={[r.byEmail, dayTime(r.notedAt)].filter(Boolean).join(" · ")}>
                                    {r.byEmail?.split("@")[0] ?? ""}
                                    <span className="mt-0.5 block">{dayTime(r.notedAt)}</span>
                                  </td>
                                  <td className="py-2 pl-3 pr-5 text-center align-top">
                                    <button type="button" disabled={busy === r.noteKey}
                                      onClick={() => void setHandled(r, !isDone)}
                                      title={isDone
                                        ? `Handled by ${r.handledBy ?? "someone"} — click to put it back`
                                        : "Mark it keyed in — the housing team sees this"}
                                      className={`press h-6 w-full rounded text-micro font-semibold ring-1 ${
                                        isDone
                                          ? "bg-brand-navy text-white ring-brand-navy"
                                          : "bg-white text-brand-navy ring-brand-navy/25 hover:ring-brand-navy/60"
                                      }`}>
                                      {isDone ? "Done" : "Mark"}
                                    </button>
                                  </td>
                                </tr>
                                <tr aria-hidden={!open}>
                                  <td colSpan={COL_COUNT} className="p-0">
                                    <Collapse open={open}>
                                      <div className="space-y-1.5 bg-brand-tint/60 py-3 pl-[3.25rem] pr-5 text-label">
                                        <p className="text-brand-ink">{r.note}</p>
                                        {r.changeType === null && (
                                          <p className="font-semibold text-brand-navy">
                                            {r.ask === "rate_change"
                                              ? "The note does not say which way the rate moved — increase, decrease or a correction are three different entries, so read it before keying."
                                              : "No type was picked — read it and route it by hand."}
                                          </p>
                                        )}
                                        {r.changeType !== null && (
                                          <p className="text-neutral-500">
                                            Keys in as <span className="font-semibold text-brand-navy">{r.changeType}</span>
                                          </p>
                                        )}
                                        {r.shift && <p className="text-neutral-500">Shift: {r.shift}</p>}
                                        <p className="text-micro text-neutral-500">
                                          {/* The facts above are a snapshot on purpose: by now
                                              Housing may well have moved them out, which is
                                              usually the very thing the note is about. */}
                                          Where they were when this was filed — not necessarily where they are now.
                                        </p>
                                        {isDone && (
                                          <p className="text-micro text-neutral-500">
                                            Handled by {r.handledBy ?? "someone"} · {dayTime(r.handledAt)}
                                            {r.handledNote ? ` — ${r.handledNote}` : ""}
                                          </p>
                                        )}
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

        {/* ⚠️ RETRACTED ROWS ARE SHOWN, NEVER DROPPED. Somebody may already have
            keyed one in, and a task that silently disappears from a queue is
            worse than one that says "this was taken back, check it". */}
        {retracted.length > 0 && (
          <Reveal index={5}>
            <section className="surface overflow-hidden rounded-card ring-1 ring-brand-line">
              <div className="band flex items-center gap-3 px-5 py-3">
                <h2 className="text-title font-semibold tracking-tight text-brand-navy">
                  Taken back by the housing team
                </h2>
                <span className="fin-num rounded-full bg-brand-wash px-2 py-0.5 text-micro font-semibold text-brand-navy">
                  {retracted.length}
                </span>
              </div>
              <ul className="divide-y divide-brand-line/70">
                {retracted.map((r) => (
                  <li key={r.noteKey} className="px-5 py-3">
                    <p className="text-body text-brand-ink">
                      {r.personName} — {r.askLabel}
                    </p>
                    <p className="mt-0.5 text-micro text-neutral-500">{r.note}</p>
                    {r.handledAt && (
                      <p className="mt-0.5 text-micro text-bad">
                        You had already marked this handled — check whether it needs undoing in Zenople.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </Reveal>
        )}
      </div>
    </AppShell>
  );
}
