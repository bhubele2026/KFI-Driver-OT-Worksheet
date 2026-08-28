import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";
import { useAccess } from "@/lib/access";
import { TieOutPanel } from "@/components/tie-out-panel";

/**
 * Payroll Process — the checklist for the current pay period, live.
 *
 * This is the spine of the weekly run. The 52 steps come from the `Checklist`
 * tab of the changes workbook, which is the real specification for the week,
 * and they are grouped by the day they belong to so the board reads the way the
 * week is actually worked rather than as one long list.
 */

type Step = {
  id: number;
  key: string;
  ordinal: number;
  day: string;
  task: string;
  tile: string | null;
  parentId: number | null;
  status: "pending" | "in_progress" | "done" | "blocked" | "skipped";
  blockedOn: string | null;
  note: string | null;
};

type Period = {
  id: number;
  payDate: string;
  label: string;
  isOffCycle: boolean;
  weekStart?: string;
  ppeDate?: string;
  accountingPeriod?: string;
};

type Payload = {
  period: Period;
  steps: Step[];
  counts: { total: number; done: number; blocked: number };
};

const base = import.meta.env.BASE_URL;

/** The week reads Friday through Friday — keep that order, not alphabetical. */
const DAY_ORDER = [
  "Friday", "Monday", "Monday/Tuesday", "Tuesday", "Tuesday/Wednesday",
  "Wednesday/Thursday", "Thursday", "Thursday/Friday",
];

function upcomingFriday(): string {
  const now = new Date();
  const iso = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  iso.setUTCDate(iso.getUTCDate() + ((5 - iso.getUTCDay() + 7) % 7));
  return iso.toISOString().slice(0, 10);
}

const STATUS_STYLE: Record<Step["status"], string> = {
  done: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  blocked: "bg-orange-50 text-orange-700 ring-orange-600/25",
  in_progress: "bg-sky-50 text-sky-700 ring-sky-600/20",
  skipped: "bg-zinc-100 text-zinc-500 ring-zinc-400/25",
  pending: "bg-white text-muted-foreground ring-border",
};

export default function PayrollProcess() {
  const access = useAccess();
  // The sub-tiles this person actually holds. They are separate grants, so the
  // board must not advertise a stage they cannot open.
  const subTiles = (access?.tiles ?? []).filter((t) =>
    t.href.startsWith("/payroll-process/"),
  );
  const [payDate, setPayDate] = useState(upcomingFriday);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ⚠️ Ignore a superseded response. Changing the pay date twice quickly can let
  // the FIRST, slower reply land after the second, putting one week's checklist
  // under another week's heading. In a payroll tool somebody would tick steps
  // against the wrong period.
  const seq = useRef(0);

  const load = useCallback(async (pd: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${pd}/checklist`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`checklist ${r.status}`);
      const payload = (await r.json()) as Payload;
      if (mine !== seq.current) return;
      setData(payload);
    } catch (e) {
      if (mine !== seq.current) return;
      // Say what broke. A blank board and a broken board must not look alike.
      setError(e instanceof Error ? e.message : "could not load the checklist");
      setData(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(payDate); }, [payDate, load]);

  const move = useCallback(
    async (step: Step, status: Step["status"]) => {
      // A blocked step needs a reason — the server rejects it otherwise, and
      // asking here keeps that from arriving as an unexplained error.
      let blockedOn: string | undefined;
      if (status === "blocked") {
        const answer = window.prompt(`What is "${step.task}" waiting on?`);
        if (!answer) return;
        blockedOn = answer;
      }
      setBusy(step.key);
      try {
        const r = await fetch(
          `${base}api/payroll-run/periods/${payDate}/steps/${encodeURIComponent(step.key)}`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status, blockedOn }),
          },
        );
        if (!r.ok) throw new Error(`save ${r.status}`);
        await load(payDate);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not save that step");
      } finally {
        setBusy(null);
      }
    },
    [payDate, load],
  );

  const byDay = useMemo(() => {
    const groups = new Map<string, Step[]>();
    for (const s of data?.steps ?? []) {
      const arr = groups.get(s.day);
      if (arr) arr.push(s);
      else groups.set(s.day, [s]);
    }
    // Unknown days sort last rather than first — indexOf returns -1.
    const rank = (d: string) => {
      const i = DAY_ORDER.indexOf(d);
      return i === -1 ? DAY_ORDER.length : i;
    };
    return [...groups].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [data]);

  const pct = data && data.counts.total > 0
    ? Math.round((data.counts.done / data.counts.total) * 100)
    : 0;

  return (
    <AppShell active="/payroll-process">
      <div className="rise-in space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-brand-navy">Payroll Process</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {data?.period
                ? `${data.period.label}${
                    data.period.weekStart
                      ? ` — week worked ${data.period.weekStart} to ${data.period.ppeDate}, accounting period ${data.period.accountingPeriod}`
                      : ""
                  }`
                : "The checklist for this pay period."}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Pay date
            <input
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              className="fin-num rounded-md border border-border bg-white px-2 py-1 text-sm text-foreground"
            />
          </label>
        </div>

        {data && (
          <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-border">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-brand-navy">
                {data.counts.done} of {data.counts.total} done
              </span>
              {data.counts.blocked > 0 && (
                <span className="text-sm font-medium text-orange-700">
                  {data.counts.blocked} blocked
                </span>
              )}
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
              <div
                className="h-full rounded-full bg-brand-navy transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        {subTiles.length > 0 && (
          <div className="stagger grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {subTiles.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                className="rounded-lg bg-white px-3 py-2.5 text-sm font-medium text-brand-navy no-underline shadow-sm ring-1 ring-border transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-md hover:ring-brand-navy/25"
              >
                {t.title}
              </Link>
            ))}
          </div>
        )}

        <TieOutPanel payDate={payDate} />

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data ? null : (
          <div className="stagger space-y-5">
            {byDay.map(([day, steps]) => (
              <section key={day} className="rounded-lg bg-white shadow-sm ring-1 ring-border">
                <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold text-brand-navy">
                  {day}
                </h2>
                <ul className="divide-y divide-border">
                  {steps.map((s) => (
                    <li
                      key={s.key}
                      className={`flex flex-wrap items-start gap-3 px-4 py-3 ${
                        s.parentId ? "pl-10" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={s.status === "done"}
                        disabled={busy === s.key}
                        onChange={(e) => void move(s, e.target.checked ? "done" : "pending")}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[var(--brand-navy,#0f2740)]"
                        aria-label={s.task}
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-sm ${
                            s.status === "done"
                              ? "text-muted-foreground line-through"
                              : "text-foreground"
                          }`}
                        >
                          {s.task}
                        </p>
                        {s.blockedOn && (
                          <p className="mt-0.5 text-xs text-orange-700">
                            Waiting on {s.blockedOn}
                          </p>
                        )}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                          STATUS_STYLE[s.status]
                        }`}
                      >
                        {s.status.replace("_", " ")}
                      </span>
                      {s.status !== "blocked" && s.status !== "done" && (
                        <button
                          type="button"
                          disabled={busy === s.key}
                          onClick={() => void move(s, "blocked")}
                          className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border transition-colors hover:text-orange-700 hover:ring-orange-600/30"
                        >
                          Block
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
