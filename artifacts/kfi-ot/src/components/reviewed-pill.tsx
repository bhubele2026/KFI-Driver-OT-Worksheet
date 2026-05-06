import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReviewedPillProps {
  reviewed: number;
  total: number;
  className?: string;
  testId?: string;
}

export function ReviewedPill({ reviewed, total, className, testId }: ReviewedPillProps) {
  const allDone = total > 0 && reviewed >= total;
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium border",
        allDone
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
          : "bg-muted text-muted-foreground border-border",
        className,
      )}
    >
      {allDone ? (
        <>
          <CheckCircle2 className="h-3.5 w-3.5" />
          All reviewed
        </>
      ) : (
        <>
          {reviewed} / {total} reviewed
        </>
      )}
    </span>
  );
}
