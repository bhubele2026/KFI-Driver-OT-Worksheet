import { Users } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PresenceViewer } from "@/lib/realtime";

interface Props {
  viewers: PresenceViewer[];
  selfEmail?: string | null;
}

function initialsOf(email: string): string {
  const base = email.split("@")[0] ?? email;
  const parts = base.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return email.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const PALETTE = [
  "bg-teal-600",
  "bg-indigo-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-emerald-600",
  "bg-sky-600",
];

function colorFor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/**
 * "Who's viewing" chip. Renders one avatar bubble per active viewer (other
 * than the current user). Empty when nobody else is on the page, so the
 * header stays calm.
 */
export function PresenceChip({ viewers, selfEmail }: Props) {
  const others = viewers.filter((v) => v.email !== selfEmail);
  if (others.length === 0) return null;
  const visible = others.slice(0, 5);
  const overflow = others.length - visible.length;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-mono"
            data-testid="presence-chip"
          >
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <div className="flex -space-x-1.5">
              {visible.map((v) => (
                <span
                  key={v.userId}
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-1 ring-card ${colorFor(v.email)}`}
                  data-testid={`presence-avatar-${v.userId}`}
                >
                  {initialsOf(v.email)}
                </span>
              ))}
              {overflow > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground ring-1 ring-card">
                  +{overflow}
                </span>
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="text-xs font-semibold mb-1">
            {others.length} other viewer{others.length === 1 ? "" : "s"}
          </div>
          <ul className="space-y-0.5 text-xs">
            {others.map((v) => (
              <li key={v.userId} className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${colorFor(v.email)}`}
                />
                <span className="font-mono">{v.email}</span>
                {v.kfiId && (
                  <span className="text-muted-foreground">· {v.kfiId}</span>
                )}
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
