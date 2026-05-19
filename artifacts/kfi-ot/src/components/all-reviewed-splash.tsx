import { CheckCircle2, X } from "lucide-react";
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
