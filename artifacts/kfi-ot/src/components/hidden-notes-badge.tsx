import { Link } from "wouter";
import {
  useGetHiddenNotesUnseenCount,
  useGetMe,
  getGetHiddenNotesUnseenCountQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EyeOff } from "lucide-react";

type Variant = "nav" | "compact";

export function HiddenNotesBadge({ variant = "nav" }: { variant?: Variant }) {
  const { data: me } = useGetMe();
  const enabled = !!me?.isAdmin;
  const { data } = useGetHiddenNotesUnseenCount({
    query: {
      enabled,
      queryKey: getGetHiddenNotesUnseenCountQueryKey(),
      refetchOnWindowFocus: true,
    },
  });
  if (!enabled) return null;
  const count = data?.count ?? 0;

  if (variant === "compact") {
    if (count <= 0) return null;
    return (
      <Link href="/admin/notes">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-amber-500/60 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
          data-testid="badge-hidden-notes-compact"
          title={`${count} note${count === 1 ? "" : "s"} hidden since you last checked`}
        >
          <EyeOff className="h-4 w-4 mr-2" />
          {count} hidden
        </Button>
      </Link>
    );
  }

  return (
    <Link href="/admin/notes">
      <Button
        variant="ghost"
        size="sm"
        className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8 relative"
        data-testid="link-hidden-notes"
      >
        Hidden notes
        {count > 0 && (
          <Badge
            variant="destructive"
            className="ml-2 px-1.5 h-5 min-w-5 font-mono text-[10px] tabular-nums"
            data-testid="badge-hidden-notes-unseen"
          >
            {count > 99 ? "99+" : count}
          </Badge>
        )}
      </Button>
    </Link>
  );
}
