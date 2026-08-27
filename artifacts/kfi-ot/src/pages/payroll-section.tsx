import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/app-shell";

/**
 * One payroll sub-tile.
 *
 * Every payroll tile owns a slice of the same 52-step checklist, so rather than
 * eleven empty placeholders each tile renders its own steps for the current pay
 * period — that is real work on day one — plus a plain statement of the tooling
 * still to come. A page that says nothing is worse than a page that says what
 * it does not do yet.
 */

type Step = {
  key: string;
  day: string;
  task: string;
  tile: string | null;
  parentId: number | null;
  status: "pending" | "in_progress" | "done" | "blocked" | "skipped";
  blockedOn: string | null;
};

type Payload = { period: { label: string }; steps: Step[] };

const base = import.meta.env.BASE_URL;

function upcomingFriday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

export type PayrollSectionProps = {
  /** Matches `tile` on the checklist steps, and the tile key in the registry. */
  tileKey: string;
  href: string;
  title: string;
  intro: string;
  /** What this tile will do once its tooling lands. Plain, not a promise. */
  upcoming: string[];
};

export function PayrollSection({ tileKey, href, title, intro, upcoming }: PayrollSectionProps) {
  const [payDate] = useState(upcomingFriday);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${base}api/payroll-run/periods/${payDate}/checklist`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`checklist ${r.status}`);
      const d = (await r.json()) as Payload;
      setLabel(d.period.label);
      setSteps(d.steps.filter((s) => s.tile === tileKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load this tile's steps");
    }
  }, [payDate, tileKey]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppShell active={href}>
      <div className="rise-in space-y-5">
        <div>
          <Link
            href="/payroll-process"
            className="text-xs font-medium text-muted-foreground no-underline hover:text-brand-navy"
          >
            ← Payroll Process
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-brand-navy">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
        </div>

        {error && (
          <div className="rounded-lg bg-orange-50 p-4 text-sm text-orange-800 ring-1 ring-orange-600/25">
            {error}
          </div>
        )}

        <section className="rounded-lg bg-white shadow-sm ring-1 ring-border">
          <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold text-brand-navy">
            This tile&rsquo;s steps{label ? ` — ${label}` : ""}
          </h2>
          {steps === null ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
          ) : steps.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No checklist steps belong to this tile.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {steps.map((s) => (
                <li key={s.key} className={`px-4 py-3 ${s.parentId ? "pl-10" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className={`text-sm ${
                          s.status === "done"
                            ? "text-muted-foreground line-through"
                            : "text-foreground"
                        }`}
                      >
                        {s.task}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{s.day}</p>
                      {s.blockedOn && (
                        <p className="mt-0.5 text-xs text-orange-700">Waiting on {s.blockedOn}</p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {s.status.replace("_", " ")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            Tick steps on the{" "}
            <Link href="/payroll-process" className="text-brand-navy no-underline hover:underline">
              Payroll Process
            </Link>{" "}
            board — this is the same checklist, filtered.
          </p>
        </section>

        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-border">
          <h2 className="text-sm font-semibold text-brand-navy">Still to build here</h2>
          <ul className="mt-2 space-y-1.5">
            {upcoming.map((u) => (
              <li key={u} className="flex gap-2 text-sm text-muted-foreground">
                <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-zinc-300" />
                <span>{u}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
