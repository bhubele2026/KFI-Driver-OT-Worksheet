import type { ReactNode } from "react";
import { format, parseISO, addWeeks } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
  const currentSunday = getSunday(today);
  const windowStart = format(addWeeks(currentSunday, -WEEKS_BACK), "yyyy-MM-dd");
  const windowEnd = format(addWeeks(currentSunday, WEEKS_FWD), "yyyy-MM-dd");

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

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-border">
      {title && <div className="mr-1 text-sm font-semibold text-brand-navy">{title}</div>}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => go(-1)} title={t("header.previousWeek")}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => go(1)} title={t("header.nextWeek")}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <Select value={weekStart} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-[210px] fin-num text-sm">
          <SelectValue placeholder={t("header.selectWeek")} />
        </SelectTrigger>
        <SelectContent>
          {weeks.map((w) => (
            <SelectItem key={w.startDate} value={w.startDate} className="fin-num">
              {t("weekSummary.weekRangeOption", { start: w.startDate, end: w.endDate })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input
        type="date"
        title={t("header.jumpTo")}
        className="fin-num h-8 w-36 rounded-md border border-input bg-white px-2 text-sm"
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
