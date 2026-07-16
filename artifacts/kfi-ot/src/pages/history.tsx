import { Link } from "wouter";
import { useListWeeks } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/app-shell";

interface WeekRow {
  startDate: string;
  endDate: string;
  driverCount?: number;
  lastRefreshedAt?: string | null;
}

export default function History() {
  const { t } = useTranslation();
  const { data, isLoading } = useListWeeks();
  const weeks = ((data ?? []) as WeekRow[])
    .filter((w) => w.startDate < "2030-01-01") // hide far-future test weeks
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));

  return (
    <AppShell active="/history">
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">History</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Open any past payroll week to review hours or reprint timesheets.
          </p>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : weeks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No weeks yet.</p>
        ) : (
          <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {weeks.map((w) => (
              <Link
                key={w.startDate}
                href={`/timesheets/${w.startDate}`}
                className="group flex flex-col rounded-2xl bg-white p-5 no-underline shadow-sm ring-1 ring-border transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-md hover:ring-brand-navy/25"
              >
                <div className="fin-num text-base font-semibold text-brand-navy">
                  {t("weekSummary.weekRangeOption", { start: w.startDate, end: w.endDate })}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {typeof w.driverCount === "number"
                    ? `${w.driverCount} drivers`
                    : "Payroll week"}
                  {w.lastRefreshedAt
                    ? ` · refreshed ${new Date(w.lastRefreshedAt).toLocaleDateString()}`
                    : ""}
                </div>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-4 text-[11px] font-medium uppercase tracking-wide text-neutral-400 transition-colors group-hover:text-brand-orange">
                  Open week
                  <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
