import { CheckCircle2, PartyPopper, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

export function AllReviewedSplash({ visible, onDismiss }: Props) {
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="all-reviewed-splash"
      className="fixed top-20 left-1/2 -translate-x-1/2 z-40 inline-flex items-center gap-3 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-800 dark:text-emerald-200 shadow-lg backdrop-blur"
    >
      <CheckCircle2 className="h-4 w-4" />
      <span>All drivers reviewed for this week</span>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDismiss}
        aria-label="Dismiss"
        data-testid="button-all-reviewed-dismiss"
        className="h-6 w-6 text-emerald-800 hover:bg-emerald-500/20 dark:text-emerald-200"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * Bigger, gold-leaning sibling of AllReviewedSplash. Fires when the week
 * is the actual payroll finish line — everyone reviewed AND zero
 * outstanding alerts. Styled deliberately differently (pill -> card,
 * emerald -> amber gradient, single-line -> headline + sub) so a
 * dispatcher can tell at a glance which milestone just hit.
 */
export function FullyReconciledSplash({ visible, onDismiss }: Props) {
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="fully-reconciled-splash"
      className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 rounded-2xl border-2 border-amber-400/60 bg-gradient-to-br from-amber-400/25 via-amber-300/15 to-amber-500/25 px-6 py-4 shadow-2xl backdrop-blur ring-1 ring-amber-200/30 dark:from-amber-500/25 dark:via-amber-400/15 dark:to-amber-600/25"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-400/30 text-amber-700 dark:text-amber-200">
        <PartyPopper className="h-5 w-5" />
      </div>
      <div className="flex flex-col">
        <span className="font-display text-base font-bold tracking-tight text-amber-900 dark:text-amber-100">
          Week is ready for payroll
        </span>
        <span className="text-xs text-amber-800/80 dark:text-amber-200/80">
          Every driver reviewed and zero outstanding alerts. Go home.
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDismiss}
        aria-label="Dismiss"
        data-testid="button-fully-reconciled-dismiss"
        className="h-7 w-7 text-amber-900 hover:bg-amber-400/30 dark:text-amber-100"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
