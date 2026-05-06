import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetMe,
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
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type FilterChip = "unreviewed" | "ot" | "mismatch";

const CHIP_LABELS: Record<FilterChip, string> = {
  unreviewed: "Un-reviewed",
  ot: "Has OT",
  mismatch: "Mismatch",
};

function driverHasMismatch(driver: {
  driverHours: number;
  customerHours: number;
}): boolean {
  return (
    driver.driverHours > 0 &&
    driver.customerHours > 0 &&
    Math.abs(driver.driverHours - driver.customerHours) > 0.05
  );
}

interface SidebarProps {
  weekStart: string;
  selectedKfiId?: string;
  collapsed: boolean;
  onToggle: () => void;
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

interface ListProps {
  weekStart: string;
  selectedKfiId?: string;
  onNavigate?: () => void;
  search: string;
  chips: Set<FilterChip>;
}

function DriversList({
  weekStart,
  selectedKfiId,
  onNavigate,
  search,
  chips,
}: ListProps) {
  const [, setLocation] = useLocation();
  const { data: summary } = useGetWeekSummary(weekStart);
  const toggleReviewed = useToggleReviewed(weekStart);

  const needle = search.trim().toLowerCase();
  const filterActive = needle.length > 0 || chips.size > 0;

  const filteredGroups = useMemo(() => {
    if (!summary?.customers) return [];
    return summary.customers
      .map((group) => ({
        customer: group.customer,
        drivers: group.drivers.filter((driver) => {
          if (needle) {
            const hay = `${driver.name} ${driver.kfiId}`.toLowerCase();
            if (!hay.includes(needle)) return false;
          }
          if (chips.has("unreviewed") && driver.reviewed) return false;
          if (chips.has("ot") && !driver.hasOvertime) return false;
          if (chips.has("mismatch") && !driverHasMismatch(driver)) return false;
          return true;
        }),
      }))
      .filter((group) => group.drivers.length > 0);
  }, [summary?.customers, needle, chips]);

  if (!summary?.customers || summary.customers.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        No drivers loaded. Click "Refresh Connecteam" to pull this week.
      </p>
    );
  }

  if (filteredGroups.length === 0) {
    return (
      <p
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid="sidebar-empty-filtered"
      >
        {filterActive
          ? "No drivers match the current filters."
          : "No drivers loaded."}
      </p>
    );
  }

  return (
    <ul className="py-2">
      {filteredGroups.map((group) => (
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

interface FilterControlsProps {
  search: string;
  onSearchChange: (value: string) => void;
  chips: Set<FilterChip>;
  onToggleChip: (chip: FilterChip) => void;
}

function FilterControls({
  search,
  onSearchChange,
  chips,
  onToggleChip,
}: FilterControlsProps) {
  const chipKeys: FilterChip[] = ["unreviewed", "ot", "mismatch"];
  return (
    <div className="px-3 py-2 border-b border-border bg-muted/20 space-y-2">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search name or KFI ID"
          aria-label="Search drivers"
          data-testid="input-sidebar-search"
          className="h-8 pl-7 pr-7 text-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            data-testid="button-sidebar-search-clear"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chipKeys.map((key) => {
          const active = chips.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onToggleChip(key)}
              aria-pressed={active}
              data-testid={`chip-filter-${key}`}
              className={cn(
                "text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border transition-colors",
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-foreground/40",
              )}
            >
              {CHIP_LABELS[key]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const FILTERS_STORAGE_PREFIX = "kfi-ot:drivers-sidebar:filters:v1";
const VALID_CHIPS: readonly FilterChip[] = ["unreviewed", "ot", "mismatch"];

interface PersistedFilters {
  search: string;
  chips: FilterChip[];
}

function buildStorageKey(userId: number | null, weekStart: string): string | null {
  if (userId == null) return null;
  return `${FILTERS_STORAGE_PREFIX}:${userId}:${weekStart}`;
}

function readPersistedFilters(storageKey: string | null): PersistedFilters | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as { search?: unknown; chips?: unknown };
    const search = typeof obj.search === "string" ? obj.search : "";
    const chips = Array.isArray(obj.chips)
      ? (obj.chips.filter((c): c is FilterChip =>
          typeof c === "string" && (VALID_CHIPS as readonly string[]).includes(c),
        ))
      : [];
    if (!search && chips.length === 0) return null;
    return { search, chips };
  } catch {
    return null;
  }
}

function useDriverFilters(weekStart: string) {
  const { data: me } = useGetMe();
  const userId =
    me && typeof me === "object" && "id" in me && typeof me.id === "number"
      ? me.id
      : null;
  const storageKey = buildStorageKey(userId, weekStart);

  const [search, setSearch] = useState<string>("");
  const [chips, setChips] = useState<Set<FilterChip>>(() => new Set());
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);

  // Hydrate (or re-hydrate) when the storage key changes — i.e. once the
  // current user is known, or when the dispatcher switches weeks.
  useEffect(() => {
    if (!storageKey) return;
    const persisted = readPersistedFilters(storageKey);
    setSearch(persisted?.search ?? "");
    setChips(new Set(persisted?.chips ?? []));
    setHydratedKey(storageKey);
  }, [storageKey]);

  const toggleChip = (chip: FilterChip) => {
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(chip)) next.delete(chip);
      else next.add(chip);
      return next;
    });
  };

  useEffect(() => {
    // Don't write until the current key has been hydrated, otherwise we
    // would clobber a previously-stored value with a momentary empty state.
    if (typeof window === "undefined") return;
    if (!storageKey || hydratedKey !== storageKey) return;
    try {
      if (!search && chips.size === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        const payload: PersistedFilters = {
          search,
          chips: VALID_CHIPS.filter((c) => chips.has(c)),
        };
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      }
    } catch {
      // ignore quota / disabled storage
    }
  }, [search, chips, storageKey, hydratedKey]);

  return { search, setSearch, chips, toggleChip };
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
          title="Shortcuts: j/↓ next driver · k/↑ previous driver · n next unreviewed · p previous unreviewed · r toggle reviewed · ? for help"
        >
          Click to open · double-click to review · <span className="font-mono">j/k</span> to jump · <span className="font-mono">n/p</span> for unreviewed.
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
  const { search, setSearch, chips, toggleChip } = useDriverFilters(weekStart);

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
      <FilterControls
        search={search}
        onSearchChange={setSearch}
        chips={chips}
        onToggleChip={toggleChip}
      />
      <DriversList
        weekStart={weekStart}
        selectedKfiId={selectedKfiId}
        search={search}
        chips={chips}
      />
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
  const { search, setSearch, chips, toggleChip } = useDriverFilters(weekStart);
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
          <FilterControls
            search={search}
            onSearchChange={setSearch}
            chips={chips}
            onToggleChip={toggleChip}
          />
          <DriversList
            weekStart={weekStart}
            selectedKfiId={selectedKfiId}
            onNavigate={() => setOpen(false)}
            search={search}
            chips={chips}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
