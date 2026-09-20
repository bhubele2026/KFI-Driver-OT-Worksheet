import { useState } from "react";
import { Collapse, Caret } from "./motion";

/**
 * A list of check results.
 *
 * Every payroll tile produces the same shape — a named check, a verdict, a
 * sentence, and the rows that caused it — so they share one renderer. The
 * important property is that a failure shows WHO and BY HOW MUCH: "it does not
 * balance" sends someone back to a spreadsheet, "these four people" does not.
 *
 * ⚠️ THE VERDICT WORD IS NOT DECORATION — IT IS HALF THE ENCODING. The palette
 * is navy = good, grey = watch, deep orange = bad, and the standing rule is
 * that the label always says which. Three people read this board under time
 * pressure on the heaviest day of the week; deep orange (#e16d3e) and brand
 * orange (#f68d2e) are close enough that colour alone is not a signal. Never
 * drop the word to save space.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "info";

export type CheckRow = {
  check: string;
  status: CheckStatus;
  message: string;
  detail?: unknown[];
};

/**
 * ⚠️ NAVY, GREY, DEEP ORANGE — nothing else, and `ok` is the same navy as
 * ordinary text on purpose, because a passing check is the resting state and
 * should not shout. This used to be emerald/orange/amber/sky, which was a
 * category palette the house style does not have.
 */
const STYLE: Record<CheckStatus, string> = {
  pass: "bg-ok-bg text-ok ring-ok/20",
  fail: "bg-bad-bg text-bad ring-bad/30",
  warn: "bg-warn-bg text-warn ring-warn/25",
  /*
   * ⚠️ `info` IS AN OUTLINE, NOT A FILL, and there is no --color-info here on
   * purpose. There are only three status colours, so an info chip filled the
   * same navy as `pass` and the two became indistinguishable — KFI Books hit
   * this exact collapse and solved it the same way. The outline reads as "a
   * note", which is what info means, without inventing a fourth colour.
   */
  info: "bg-transparent text-ok ring-ok/35",
};

/** What a processor would call the verdict, rather than the enum's spelling. */
const VERDICT: Record<CheckStatus, string> = {
  pass: "clear",
  fail: "off",
  warn: "review",
  info: "note",
};

/** Turn a check key into a sentence-case label without a lookup table. */
function label(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Render one detail row readably.
 *
 * A payroll processor should never be reading raw JSON to find out who is short
 * two hours, so known shapes are described and anything unrecognised falls back
 * to compact key-value pairs rather than a stringified object.
 */
function describe(d: unknown): string {
  if (d === null || d === undefined) return "";
  if (typeof d === "string") return d;
  if (typeof d !== "object") return String(d);

  const o = d as Record<string, unknown>;
  const name = (o.person ?? o.name ?? o.employee) as string | undefined;

  if (name && typeof o.reason === "string") return `${name} — ${o.reason}`;
  if (name && o.net !== undefined) {
    return `${name} — net ${String(o.net)}${o.hours !== undefined ? ` on ${String(o.hours)} hours` : ""}`;
  }
  if (name && o.payHours !== undefined) {
    return `${name} — pay ${String(o.payHours)}h vs bill ${String(o.billHours)}h`;
  }
  if (name) {
    const rest = Object.entries(o)
      .filter(([k]) => !["person", "name", "employee", "personId"].includes(k))
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(", ");
    return rest ? `${name} — ${rest}` : name;
  }
  return Object.entries(o).map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
}

export function CheckPanel({
  title, checks, footer, emptyMessage = "Nothing to check yet.",
}: {
  title: string;
  checks: CheckRow[] | null;
  footer?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const failing = (checks ?? []).filter((c) => c.status === "fail").length;
  const warning = (checks ?? []).filter((c) => c.status === "warn").length;

  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  return (
    <section className="surface rounded-card ring-1 ring-brand-line">
      <div className="band flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-label font-semibold text-brand-navy">{title}</h2>
        {checks && checks.length > 0 && (
          <span className="text-micro text-neutral-500">
            {failing > 0 && <span className="font-medium text-bad">{failing} off</span>}
            {failing > 0 && warning > 0 && " · "}
            {warning > 0 && <span className="font-medium text-warn">{warning} to review</span>}
            {failing === 0 && warning === 0 && "all clear"}
          </span>
        )}
      </div>

      {checks === null ? (
        <p className="px-4 py-3 text-body text-neutral-500">Loading…</p>
      ) : checks.length === 0 ? (
        <p className="px-4 py-3 text-body text-neutral-500">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-brand-line">
          {checks.map((c) => {
            const detail = Array.isArray(c.detail) ? c.detail : [];
            const isOpen = open.has(c.check);
            const hasDetail = detail.length > 0;
            return (
              <li key={c.check} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {/*
                      The whole row is the control when there is something behind
                      it — a number you cannot open is a number you have to go
                      and look up somewhere else.
                    */}
                    {hasDetail ? (
                      <button
                        type="button"
                        onClick={() => toggle(c.check)}
                        aria-expanded={isOpen}
                        className="press -ml-1 flex items-center gap-1.5 rounded-control px-1 text-left"
                      >
                        <Caret open={isOpen} />
                        <span className="text-body font-medium text-foreground">{label(c.check)}</span>
                        <span className="text-micro text-neutral-500">
                          {detail.length} {detail.length === 1 ? "row" : "rows"}
                        </span>
                      </button>
                    ) : (
                      <p className="text-body font-medium text-foreground">{label(c.check)}</p>
                    )}
                    <p className="mt-0.5 text-body text-neutral-500">{c.message}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-micro font-medium ring-1 ${STYLE[c.status]}`}
                  >
                    {VERDICT[c.status]}
                  </span>
                </div>

                {/*
                  Every row, not the first ten. The old renderer cut the list at
                  ten and printed "and N more", which is the moment a processor
                  leaves the app for the spreadsheet — and the eleventh person is
                  as unpaid as the first.
                */}
                {hasDetail && (
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
        </ul>
      )}

      {footer && (
        <p className="border-t border-brand-line px-4 py-2.5 text-micro text-neutral-500">{footer}</p>
      )}
    </section>
  );
}
