import { useState } from "react";
import { useLocation } from "wouter";
import {
  useGetWeekSummary,
  useSetReviewed,
  getGetWeekSummaryQueryKey,
  getGetDriverWeekQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface SidebarProps {
  weekStart: string;
  selectedKfiId?: string;
  collapsed: boolean;
  onToggle: () => void;
}

interface ListProps {
  weekStart: string;
  selectedKfiId?: string;
  onNavigate?: () => void;
}

function useToggleReviewed(weekStart: string) {
  const setReviewed = useSetReviewed();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return (kfiId: string, currentVal: boolean) => {
    setReviewed.mutate(
      { weekStart, kfiId, data: { reviewed: !currentVal } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
          });
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to update review status",
            variant: "destructive",
          });
        },
      },
    );
  };
}

function DriversList({ weekStart, selectedKfiId, onNavigate }: ListProps) {
  const [, setLocation] = useLocation();
  const { data: summary } = useGetWeekSummary(weekStart);
  const toggleReviewed = useToggleReviewed(weekStart);

  if (!summary?.customers || summary.customers.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        No drivers loaded. Click "Refresh Connecteam" to pull this week.
      </p>
    );
  }

  return (
    <ul className="py-2">
      {summary.customers.map((group) => (
        <li key={group.customer} className="mb-2">
          <div className="px-4 py-1.5 text-xs font-display font-semibold uppercase tracking-wider text-foreground/80 bg-muted/30">
            {group.customer}
            <span className="ml-2 text-[10px] font-normal font-mono text-muted-foreground">
              {group.drivers.length}
            </span>
          </div>
          <ul>
            {group.drivers.map((driver) => {
              const isActive = driver.kfiId === selectedKfiId;
              return (
                <li key={driver.kfiId}>
                  <button
                    type="button"
                    onClick={() => {
                      setLocation(`/weeks/${weekStart}/drivers/${driver.kfiId}`);
                      onNavigate?.();
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      toggleReviewed(driver.kfiId, driver.reviewed);
                    }}
                    title="Click to open · Double-click to toggle reviewed"
                    data-testid={`sidebar-driver-${driver.kfiId}`}
                    className={cn(
                      "w-full text-left px-4 py-1.5 text-sm flex items-center gap-2 transition-colors group select-none",
                      isActive
                        ? "bg-accent text-accent-foreground border-l-2 border-primary pl-[14px] font-medium"
                        : "hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {driver.reviewed ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                    )}
                    <span className="flex-1 truncate">{driver.name}</span>
                    {driver.overtimeHours > 0 && (
                      <span className="text-[10px] font-mono font-semibold text-warning bg-warning/10 px-1 rounded">
                        OT
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function SidebarHeader({ onCollapse }: { onCollapse?: () => void }) {
  return (
    <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-start justify-between gap-2">
      <div>
        <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          Drivers by Customer
        </h3>
        <p
          className="text-[11px] text-muted-foreground mt-1 leading-tight"
          title="Shortcuts: j/↓ next driver · k/↑ previous driver · r toggle reviewed · ? for help"
        >
          Click to open · double-click to review · <span className="font-mono">j/k</span> to jump.
        </p>
      </div>
      {onCollapse && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onCollapse}
          title="Collapse sidebar"
          className="h-7 w-7 shrink-0 -mr-1 text-muted-foreground hover:text-foreground"
          data-testid="button-collapse-sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

export function DriversSidebar({ weekStart, selectedKfiId, collapsed, onToggle }: SidebarProps) {
  if (collapsed) {
    return (
      <aside
        className="w-10 shrink-0 border-r border-border bg-muted/20 hidden md:flex flex-col items-center py-2"
        data-testid="drivers-sidebar-collapsed"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          title="Expand drivers sidebar"
          className="h-8 w-8"
          data-testid="button-expand-sidebar"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className="w-72 shrink-0 border-r border-border bg-muted/20 overflow-y-auto hidden md:block"
      data-testid="drivers-sidebar"
    >
      <SidebarHeader onCollapse={onToggle} />
      <DriversList weekStart={weekStart} selectedKfiId={selectedKfiId} />
    </aside>
  );
}

interface MobileTriggerProps {
  weekStart: string;
  selectedKfiId?: string;
  className?: string;
}

export function DriversSidebarMobileTrigger({
  weekStart,
  selectedKfiId,
  className,
}: MobileTriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title="Open drivers sidebar"
        data-testid="button-open-mobile-sidebar"
        className={cn("h-8 w-8 md:hidden", className)}
      >
        <Menu className="h-4 w-4" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          className="p-0 w-80 max-w-[85vw] bg-muted/20 overflow-y-auto"
        >
          <SidebarHeader />
          <DriversList
            weekStart={weekStart}
            selectedKfiId={selectedKfiId}
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
