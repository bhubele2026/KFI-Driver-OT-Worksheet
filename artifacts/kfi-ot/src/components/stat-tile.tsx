import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/use-count-up";

/**
 * Shared flat stat tile used across the week summary and driver detail (was
 * duplicated — a local component in driver-detail and hand-rolled Cards in
 * week-summary). One look everywhere: hairline ring, soft shadow, uppercase
 * label, tabular figure.
 */
export function StatTile({
  label,
  value,
  tone,
  testId,
  decimals = 2,
  highlight = false,
}: {
  label: string;
  value: number;
  /** Tailwind text-color class for the value (e.g. "text-brand-navy"). */
  tone?: string;
  testId?: string;
  /** 2 for hours, 0 for whole counts. */
  decimals?: number;
  /** Emphasized tile (overtime). */
  highlight?: boolean;
}) {
  const animated = useCountUp(value);
  return (
    <div
      className={cn(
        "rounded-lg p-4 shadow-sm ring-1",
        highlight ? "bg-warning/5 ring-warning/40" : "bg-card ring-border",
      )}
      data-testid={testId}
    >
      <div
        className={cn(
          "text-[11px] font-semibold uppercase tracking-wide",
          highlight ? "text-warning" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "mt-1 fin-num text-2xl font-semibold",
          tone ?? (highlight ? "text-warning" : "text-foreground"),
        )}
      >
        {decimals === 0 ? Math.round(animated) : animated.toFixed(decimals)}
      </div>
    </div>
  );
}
