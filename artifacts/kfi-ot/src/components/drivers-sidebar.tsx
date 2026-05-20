import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import {
  useGetMe,
  useGetWeekSummary,
  useSetReviewed,
  useClearDriverCustomerOverride,
  getGetWeekSummaryQueryKey,
  getGetDriverWeekQueryKey,
  getListDriverCustomerOverridesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  Flag,
  Lock,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Shuffle,
  X,
  XCircle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoveDriverCustomerDialog } from "@/components/move-driver-customer-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { readAutoAdvancePref } from "@/hooks/use-auto-advance";
import { cn } from "@/lib/utils";
import { formatPersonName } from "@/lib/format-name";

type FilterChip = "unreviewed";

interface SidebarProps {
  weekStart: string;
  selectedKfiId?: string;
  collapsed: boolean;
  onToggle: () => void;
}

function useToggleReviewed(
  weekStart: string,
  onAfterToggle?: (kfiId: string, newVal: boolean) => void,
) {
  const setReviewed = useSetReviewed();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useTranslation();

  return (kfiId: string, currentVal: boolean) => {
    const newVal = !currentVal;
    setReviewed.mutate(
      { weekStart, kfiId, data: { reviewed: newVal } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDriverWeekQueryKey(weekStart, kfiId),
          });
          onAfterToggle?.(kfiId, newVal);
        },
        onError: () => {
          toast({
            title: t("weekSummary.errorTitle"),
            description: t("weekSummary.updateReviewFailed"),
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
  const { t } = useTranslation();
  const { data: summary } = useGetWeekSummary(weekStart);
  const { toast } = useToast();
  const qc = useQueryClient();
  const clearOverride = useClearDriverCustomerOverride();
  const [moveDialog, setMoveDialog] = useState<{
    kfiId: string;
    name: string;
    customer: string;
    originalCustomer: string | null;
  } | null>(null);

  const handleClearOverride = (kfiId: string, name: string) => {
    clearOverride.mutate(
      { params: { kfiId } },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          qc.invalidateQueries({
            queryKey: getListDriverCustomerOverridesQueryKey(),
          });
          toast({
            title: t("driversSidebar.toast.clearedOverrideTitle", { name }),
            description: t("driversSidebar.toast.clearedOverrideDesc"),
          });
        },
        onError: (err) =>
          toast({
            title: t("driversSidebar.toast.clearOverrideFailedTitle"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
            variant: "destructive",
          }),
      },
    );
  };

  const toggleReviewed = useToggleReviewed(weekStart, (toggledId, newVal) => {
    if (!newVal) return;
    if (toggledId !== selectedKfiId) return;
    if (!readAutoAdvancePref()) return;
    if (!summary?.customers) return;
    const flat = summary.customers.flatMap((g) =>
      g.drivers.map((d) => ({ kfiId: d.kfiId, reviewed: d.reviewed })),
    );
    const len = flat.length;
    if (len === 0) return;
    const startIdx = flat.findIndex((d) => d.kfiId === toggledId);
    const base = startIdx === -1 ? -1 : startIdx;
    let nextId: string | null = null;
    for (let step = 1; step <= len; step++) {
      const probe = (((base + step) % len) + len) % len;
      const d = flat[probe];
      if (d.kfiId === toggledId) continue;
      if (!d.reviewed) {
        nextId = d.kfiId;
        break;
      }
    }
    if (nextId) {
      setLocation(`/weeks/${weekStart}/drivers/${nextId}`);
      onNavigate?.();
    } else {
      toast({ title: t("driversSidebar.toast.allReviewed") });
    }
  });

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
          return true;
        }),
      }))
      .filter((group) => group.drivers.length > 0);
  }, [summary?.customers, needle, chips]);

  if (!summary?.customers || summary.customers.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        {t("driversSidebar.empty.noDriversInstructions")}
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
          ? t("driversSidebar.empty.noMatch")
          : t("driversSidebar.empty.noDrivers")}
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
              const status = (driver as { reviewStatus?: string }).reviewStatus;
              const isBad = status === "bad";
              const navigate = () => {
                setLocation(`/weeks/${weekStart}/drivers/${driver.kfiId}`);
                onNavigate?.();
              };
              const bubbleLabel = driver.reviewed
                ? t("driversSidebar.bubble.markUnreviewed", { name: driver.name })
                : t("driversSidebar.bubble.markReviewed", { name: driver.name });
              const flaggedCount = (driver as { flaggedPunchCount?: number })
                .flaggedPunchCount;
              const originalCustomer = (driver as {
                originalCustomer?: string | null;
              }).originalCustomer;
              const overrideSetByEmail = (driver as {
                overrideSetByEmail?: string | null;
              }).overrideSetByEmail;
              const overrideSetAt = (driver as {
                overrideSetAt?: string | null;
              }).overrideSetAt;
              return (
                <li key={driver.kfiId}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={navigate}
                    onDoubleClick={(e) => {
                      if (isBad) return;
                      e.preventDefault();
                      toggleReviewed(driver.kfiId, driver.reviewed);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate();
                      }
                    }}
                    title={t("driversSidebar.rowTitle")}
                    data-testid={`sidebar-driver-${driver.kfiId}`}
                    className={cn(
                      "w-full text-left px-4 py-1.5 text-sm flex items-center gap-2 transition-colors group select-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive
                        ? "bg-accent text-accent-foreground border-l-2 border-primary pl-[14px] font-medium"
                        : "hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isBad) return;
                        toggleReviewed(driver.kfiId, driver.reviewed);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                      }}
                      disabled={isBad}
                      aria-label={
                        isBad
                          ? t("driversSidebar.bubble.flaggedBad", { name: driver.name })
                          : bubbleLabel
                      }
                      title={
                        isBad
                          ? t("driversSidebar.bubble.markedBadInfo")
                          : bubbleLabel
                      }
                      data-testid={`sidebar-bubble-${driver.kfiId}`}
                      className={cn(
                        "inline-flex items-center justify-center h-5 w-5 rounded-full shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isBad
                          ? "cursor-not-allowed"
                          : "hover:bg-foreground/10 cursor-pointer",
                      )}
                    >
                      {isBad ? (
                        <XCircle
                          className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400"
                          data-testid={`sidebar-status-bad-${driver.kfiId}`}
                        />
                      ) : driver.reviewed || status === "good" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-muted-foreground/70" />
                      )}
                    </button>
                    <span className="flex-1 truncate">{formatPersonName(driver.name)}</span>
                    {(driver as { locked?: boolean }).locked && (
                      <Lock
                        className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0"
                        data-testid={`sidebar-locked-${driver.kfiId}`}
                      />
                    )}
                    {driver.overtimeHours > 0 && (
                      <span className="text-[10px] font-mono font-semibold text-warning bg-warning/10 px-1 rounded">
                        {t("driversSidebar.badge.ot")}
                      </span>
                    )}
                    {flaggedCount ? (
                      <span
                        className="inline-flex items-center gap-0.5 text-[10px] font-mono font-semibold text-rose-700 dark:text-rose-300 bg-rose-500/15 px-1 rounded"
                        title={t(
                          flaggedCount === 1
                            ? "driversSidebar.badge.flaggedTitle_one"
                            : "driversSidebar.badge.flaggedTitle_other",
                          { count: flaggedCount },
                        )}
                        data-testid={`sidebar-flag-count-${driver.kfiId}`}
                      >
                        <Flag className="h-2.5 w-2.5 fill-current" />
                        {flaggedCount}
                      </span>
                    ) : null}
                    {originalCustomer && (
                      <span
                        className="text-[10px] font-mono font-semibold text-sky-700 dark:text-sky-300 bg-sky-500/10 px-1 rounded"
                        title={t("driversSidebar.movedTitle", {
                          from: originalCustomer,
                          by: overrideSetByEmail
                            ? t("driversSidebar.movedBy", { email: overrideSetByEmail })
                            : "",
                          when: overrideSetAt
                            ? t("driversSidebar.movedOn", { date: overrideSetAt.slice(0, 10) })
                            : "",
                        })}
                        data-testid={`sidebar-moved-${driver.kfiId}`}
                      >
                        {t("driversSidebar.movedLabel")}
                      </span>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          aria-label={t("driversSidebar.actionsAria", { name: driver.name })}
                          title={t("driversSidebar.actionsTitle")}
                          data-testid={`sidebar-actions-${driver.kfiId}`}
                          className="inline-flex items-center justify-center h-5 w-5 rounded shrink-0 text-muted-foreground/60 hover:text-foreground hover:bg-foreground/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenuItem
                          onSelect={(e) => {
                            e.preventDefault();
                            setMoveDialog({
                              kfiId: driver.kfiId,
                              name: driver.name,
                              customer: driver.customer,
                              originalCustomer: originalCustomer ?? null,
                            });
                          }}
                          data-testid={`sidebar-move-${driver.kfiId}`}
                        >
                          <Shuffle className="h-3.5 w-3.5 mr-2" />
                          {t("driversSidebar.moveToCustomer")}
                        </DropdownMenuItem>
                        {originalCustomer && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={(e) => {
                                e.preventDefault();
                                handleClearOverride(driver.kfiId, driver.name);
                              }}
                              data-testid={`sidebar-clear-override-${driver.kfiId}`}
                            >
                              <X className="h-3.5 w-3.5 mr-2" />
                              {t("driversSidebar.clearOverride")}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
      {moveDialog && (
        <MoveDriverCustomerDialog
          weekStart={weekStart}
          open={!!moveDialog}
          onOpenChange={(o) => {
            if (!o) setMoveDialog(null);
          }}
          driver={moveDialog}
        />
      )}
    </ul>
  );
}

interface FilterCountProps {
  weekStart: string;
  search: string;
  chips: Set<FilterChip>;
}

function FilterCountBadge({ weekStart, search, chips }: FilterCountProps) {
  const { t } = useTranslation();
  const { data: summary } = useGetWeekSummary(weekStart);
  const needle = search.trim().toLowerCase();
  const filterActive = needle.length > 0 || chips.size > 0;

  const counts = useMemo(() => {
    let total = 0;
    let matched = 0;
    if (!summary?.customers) return { total, matched };
    for (const group of summary.customers) {
      for (const driver of group.drivers) {
        total += 1;
        if (needle) {
          const hay = `${driver.name} ${driver.kfiId}`.toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        if (chips.has("unreviewed") && driver.reviewed) continue;
        matched += 1;
      }
    }
    return { total, matched };
  }, [summary?.customers, needle, chips]);

  if (!filterActive || counts.total === 0) return null;

  return (
    <span
      data-testid="sidebar-filter-count"
      className="inline-flex items-center text-[10px] font-mono font-semibold uppercase tracking-wider text-muted-foreground bg-muted/60 border border-border/60 rounded px-1.5 py-0.5"
    >
      {t("driversSidebar.filterCount", { matched: counts.matched, total: counts.total })}
    </span>
  );
}

interface FilterControlsProps {
  search: string;
  onSearchChange: (value: string) => void;
  chips: Set<FilterChip>;
  onToggleChip: (chip: FilterChip) => void;
  weekStart: string;
}

function FilterControls({
  search,
  onSearchChange,
  chips,
  onToggleChip,
  weekStart,
}: FilterControlsProps) {
  const { t } = useTranslation();
  const chipKeys: FilterChip[] = ["unreviewed"];
  const chipLabels: Record<FilterChip, string> = {
    unreviewed: t("driversSidebar.chip.unreviewed"),
  };
  return (
    <div className="px-3 py-2 border-b border-border bg-muted/20 space-y-2">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("driversSidebar.searchPlaceholder")}
          aria-label={t("driversSidebar.searchAria")}
          data-testid="input-sidebar-search"
          className="h-8 pl-7 pr-7 text-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label={t("driversSidebar.searchClear")}
            data-testid="button-sidebar-search-clear"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
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
              {chipLabels[key]}
            </button>
          );
        })}
        <div className="ml-auto">
          <FilterCountBadge
            weekStart={weekStart}
            search={search}
            chips={chips}
          />
        </div>
      </div>
    </div>
  );
}

const FILTERS_STORAGE_PREFIX = "kfi-ot:drivers-sidebar:filters:v1";
const VALID_CHIPS: readonly FilterChip[] = ["unreviewed"];

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
  const { t } = useTranslation();
  return (
    <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-start justify-between gap-2">
      <div>
        <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
          {t("driversSidebar.heading")}
        </h3>
      </div>
      {onCollapse && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onCollapse}
          title={t("driversSidebar.collapse")}
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
  const { t } = useTranslation();
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
          title={t("driversSidebar.expand")}
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
        weekStart={weekStart}
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { search, setSearch, chips, toggleChip } = useDriverFilters(weekStart);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title={t("driversSidebar.openMobile")}
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
            weekStart={weekStart}
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
