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
  const weeks = (weeksList ?? []) as Array<{ startDate: string; endDate: string }>;

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
