import type { ReactNode } from "react";
import { format, parseISO, addWeeks } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useListWeeks } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The picker only offers the weeks a dispatcher is actively working: the two
// weeks leading up to now, the current payroll week, and the next week. Older
// (closed) weeks live on the History page; this also drops stray far-future
// junk rows (e.g. a bad 2031 week) that the raw /weeks list would otherwise
// surface. Tune the window here.
const WEEKS_BACK = 2;
const WEEKS_FWD = 1;

function getSunday(d: Date): Date {
  const date = new Date(d);
  date.setDate(date.getDate() - date.getDay()); // 0 = Sunday
  return date;
}

/**
 * Build the dropdown options: a small recent+next window, generated so the
 * current and next week appear even before they have any data, merged with any
 * real DB weeks that fall inside the window, plus the currently-selected week
 * (so a week opened from History still displays). Newest first.
 */
export function buildWeekOptions(
  dbWeeks: Array<{ startDate: string; endDate: string }>,
  selectedWeekStart: string,
  today: Date = new Date(),
): Array<{ startDate: string; endDate: string }> {
  const endOf = (sundayIso: string) => {
    const d = parseISO(sundayIso);
    d.setDate(d.getDate() + 6);
    return format(d, "yyyy-MM-dd");
  };
  // Anchor on the pay week (last completed week), not the in-progress calendar
  // week — that's the week the app defaults to and the dispatcher works. The
  // window then runs from a couple weeks before it through the in-progress week.
  const anchor = addWeeks(getSunday(today), -1);
  const windowStart = format(addWeeks(anchor, -WEEKS_BACK), "yyyy-MM-dd");
  const windowEnd = format(addWeeks(anchor, WEEKS_FWD), "yyyy-MM-dd");

  const map = new Map<string, { startDate: string; endDate: string }>();
  // Generated window (so current + next show even with no data yet).
  let cursor = parseISO(windowStart);
  const endTs = parseISO(windowEnd).getTime();
  while (cursor.getTime() <= endTs) {
    const s = format(cursor, "yyyy-MM-dd");
    map.set(s, { startDate: s, endDate: endOf(s) });
    cursor = addWeeks(cursor, 1);
  }
  // Real DB weeks, but only inside the window (drops 2031 junk + old weeks).
  for (const w of dbWeeks) {
    if (w.startDate >= windowStart && w.startDate <= windowEnd) {
      map.set(w.startDate, { startDate: w.startDate, endDate: w.endDate });
    }
  }
  // Always keep the selected week visible (may be an older week from History).
  if (selectedWeekStart && !map.has(selectedWeekStart)) {
    map.set(selectedWeekStart, {
      startDate: selectedWeekStart,
      endDate: endOf(selectedWeekStart),
    });
  }
  return [...map.values()].sort((a, b) =>
    a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0,
  );
}

/**
 * Sub-header week picker (prev / next / select / jump) rendered on the tint page
 * background — used by the Driver Upload and Timesheets sections. Actions for the
 * page (Refresh, Export, …) go in `actions` on the right.
 */
export function WeekToolbar({
  weekStart,
  onChange,
  title,
  actions,
}: {
  weekStart: string;
  onChange: (weekStart: string) => void;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const { data: weeksList } = useListWeeks();
  const weeks = buildWeekOptions(
    (weeksList ?? []) as Array<{ startDate: string; endDate: string }>,
    weekStart,
  );

  const go = (delta: number) =>
    onChange(format(addWeeks(parseISO(weekStart), delta), "yyyy-MM-dd"));

  // Friendly range labels ("Jul 12 – Jul 18, 2026") instead of raw ISO dates.
  const rangeLabel = (s: string, e: string) =>
    `${format(parseISO(s), "MMM d")} – ${format(parseISO(e), "MMM d, yyyy")}`;

  return (
    <div className="tile flex flex-wrap items-center gap-2 px-3 py-2.5">
      {title && <div className="mr-1 text-sm font-semibold text-brand-navy">{title}</div>}
      <div className="inline-flex items-center gap-0.5 rounded-xl border border-border bg-background p-0.5">
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={() => go(-1)} title={t("header.previousWeek")}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Select value={weekStart} onValueChange={onChange}>
          <SelectTrigger className="h-8 w-[190px] justify-center gap-1.5 border-0 bg-transparent fin-num text-sm font-medium shadow-none focus:ring-0">
            <SelectValue placeholder={t("header.selectWeek")} />
          </SelectTrigger>
          <SelectContent>
            {weeks.map((w) => (
              <SelectItem key={w.startDate} value={w.startDate} className="fin-num">
                {rangeLabel(w.startDate, w.endDate)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={() => go(1)} title={t("header.nextWeek")}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <label
        className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        title={t("header.jumpTo")}
      >
        <CalendarDays className="h-4 w-4" />
        <input
          type="date"
          className="fin-num w-[7.5rem] cursor-pointer border-0 bg-transparent p-0 text-sm text-inherit outline-none"
          onChange={(e) => e.target.value && onChange(e.target.value)}
        />
      </label>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
