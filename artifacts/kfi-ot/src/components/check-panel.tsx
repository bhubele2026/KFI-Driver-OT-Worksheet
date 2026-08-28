/**
 * A list of check results.
 *
 * Every payroll tile produces the same shape — a named check, a verdict, a
 * sentence, and the rows that caused it — so they share one renderer. The
 * important property is that a failure shows WHO and BY HOW MUCH: "it does not
 * balance" sends someone back to a spreadsheet, "these four people" does not.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "info";

export type CheckRow = {
  check: string;
  status: CheckStatus;
  message: string;
  detail?: unknown[];
};

const STYLE: Record<CheckStatus, string> = {
  pass: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  fail: "bg-orange-50 text-orange-700 ring-orange-600/25",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/25",
  info: "bg-sky-50 text-sky-700 ring-sky-600/20",
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
  const failing = (checks ?? []).filter((c) => c.status === "fail").length;
  const warning = (checks ?? []).filter((c) => c.status === "warn").length;

  return (
    <section className="rounded-lg bg-white shadow-sm ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-brand-navy">{title}</h2>
        {checks && checks.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {failing > 0 && <span className="font-medium text-orange-700">{failing} failing</span>}
            {failing > 0 && warning > 0 && " · "}
            {warning > 0 && <span className="font-medium text-amber-800">{warning} to review</span>}
            {failing === 0 && warning === 0 && "all clear"}
          </span>
        )}
      </div>

      {checks === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      ) : checks.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-border">
          {checks.map((c) => {
            const detail = Array.isArray(c.detail) ? c.detail : [];
            return (
              <li key={c.check} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{label(c.check)}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{c.message}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STYLE[c.status]}`}>
                    {c.status}
                  </span>
                </div>
                {detail.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {detail.slice(0, 10).map((d, i) => (
                      <li key={i} className="fin-num text-xs text-muted-foreground">{describe(d)}</li>
                    ))}
                    {detail.length > 10 && (
                      <li className="text-xs text-muted-foreground">
                        and {detail.length - 10} more
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {footer && (
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{footer}</p>
      )}
    </section>
  );
}
