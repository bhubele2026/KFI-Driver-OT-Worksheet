import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import {
  useGetDriverWeek,
  useGetWeekSummary,
  useCreateManualPunch,
  useEditPunch,
  useDeletePunch,
  useSetReviewed,
  useRefreshConnecteam,
  getGetDriverWeekQueryKey,
  getGetWeekSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Plus, Edit2, Trash2, AlertCircle, Save, X, RefreshCw, Keyboard, Printer } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DriversSidebar, DriversSidebarMobileTrigger } from "@/components/drivers-sidebar";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useAutoAdvancePref } from "@/hooks/use-auto-advance";

const OT_THRESHOLD = 40;

const KNOWN_CUSTOMERS = [
  "Adient",
  "Burnett",
  "DeLallo",
  "Greystone",
  "IWG",
  "LSI",
  "Penda",
  "Trienda",
  "Zenople",
];

/** Parse "YYYY-MM-DD H:MM AM" into "MM/DD, h:MM AM" prefixed with the date. */
function formatClockCell(value: string): string {
  if (!value) return "";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/);
  if (!m) return value;
  const [, , mm, dd, time] = m;
  return `${mm}/${dd}, ${time}`;
}

/**
 * Mirror of `localStrToSortMs` from artifacts/api-server/src/lib/time.ts so the
 * client running-total split uses the same chronology as the server hours
 * engine. Returns a sortable ms value for "YYYY-MM-DD H:MM AM" /
 * "YYYY-MM-DD HH:MM:SS" wall-clock strings (the absolute value is meaningless;
 * order is correct within a single driver's display tz).
 */
function localStrToSortMs(str: string | null | undefined): number | null {
  if (!str) return null;
  if (str.includes("T") || /Z$/.test(str)) {
    const t = Date.parse(str);
    return isNaN(t) ? null : t;
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d+):(\d+)(?::(\d+))?\s*([AP]M)?$/i);
  if (!m) return null;
  let hh = parseInt(m[4]);
  const mm = parseInt(m[5]);
  const ss = parseInt(m[6] ?? "0");
  const ap = (m[7] ?? "").toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  return Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), hh, mm, ss);
}

function isoDateToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isCustomerNameUseful(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed === "Unknown") return false;
  if (trimmed.toLowerCase() === "[object object]") return false;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2}(\d{2})?$|^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(trimmed)) return false;
  return true;
}

export default function DriverDetail() {
  const params = useParams();
  const weekStart = params.weekStart!;
  const kfiId = params.kfiId!;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useGetDriverWeek(weekStart, kfiId);
  const { data: weekSummary } = useGetWeekSummary(weekStart);
  const [sidebarCollapsed, , toggleSidebar] = useSidebarCollapsed();
  const [autoAdvance, setAutoAdvance] = useAutoAdvancePref();

  // Flat driver order matches the sidebar's grouping (customer -> drivers).
  const flatDriverIds = useMemo(() => {
    if (!weekSummary?.customers) return [] as string[];
    return weekSummary.customers.flatMap((g) => g.drivers.map((d) => d.kfiId));
  }, [weekSummary]);
  const flatDrivers = useMemo(() => {
    if (!weekSummary?.customers) return [] as { kfiId: string; reviewed: boolean }[];
    return weekSummary.customers.flatMap((g) =>
      g.drivers.map((d) => ({ kfiId: d.kfiId, reviewed: d.reviewed })),
    );
  }, [weekSummary]);
  type Punch = NonNullable<typeof data>["punches"][number];

  const errMsg = (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback;
  const setReviewed = useSetReviewed();
  const createPunch = useCreateManualPunch();
  const editPunch = useEditPunch();
  const deletePunch = useDeletePunch();
  const refreshCt = useRefreshConnecteam();

  const handleRefresh = () => {
    refreshCt.mutate(
      { weekStart },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          queryClient.invalidateQueries({ queryKey: getGetWeekSummaryQueryKey(weekStart) });
          toast({ title: "Refreshed from Connecteam", description: `${res.punchesUpserted} punches across ${res.driversFound} drivers.` });
        },
        onError: (err) => {
          toast({ title: "Refresh failed", description: errMsg(err, "Connecteam refresh failed"), variant: "destructive" });
        },
      },
    );
  };

  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualDate, setManualDate] = useState(weekStart);
  const [manualSource, setManualSource] = useState<"Driver" | "Customer">("Driver");
  const [manualCustomer, setManualCustomer] = useState<string>(
    data?.driver.customer && data.driver.customer !== "Unknown"
      ? data.driver.customer
      : KNOWN_CUSTOMERS[0],
  );
  const [manualClockIn, setManualClockIn] = useState("");
  const [manualClockOut, setManualClockOut] = useState("");

  const [editingPunchId, setEditingPunchId] = useState<number | null>(null);
  const [editClockIn, setEditClockIn] = useState("");
  const [editClockOut, setEditClockOut] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Keyboard shortcuts: j/ArrowDown = next driver, k/ArrowUp = previous driver,
  // r = toggle reviewed, ? = show help. Skipped while typing in inputs/textareas
  // or while the Add Punch dialog is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (isManualModalOpen) return;
      // Don't fight an open Radix dialog elsewhere on the page.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;

      const key = e.key;
      if (key === "?" ) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (key === "Escape" && shortcutsOpen) {
        setShortcutsOpen(false);
        return;
      }

      if (key === "j" || key === "ArrowDown") {
        if (flatDriverIds.length === 0) return;
        e.preventDefault();
        const idx = flatDriverIds.indexOf(kfiId);
        const next = flatDriverIds[(idx === -1 ? 0 : idx + 1) % flatDriverIds.length];
        setLocation(`/weeks/${weekStart}/drivers/${next}`);
        return;
      }
      if (key === "k" || key === "ArrowUp") {
        if (flatDriverIds.length === 0) return;
        e.preventDefault();
        const idx = flatDriverIds.indexOf(kfiId);
        const len = flatDriverIds.length;
        const prev = flatDriverIds[(idx === -1 ? 0 : (idx - 1 + len) % len)];
        setLocation(`/weeks/${weekStart}/drivers/${prev}`);
        return;
      }
      if (key === "n" || key === "N" || key === "p" || key === "P") {
        if (flatDrivers.length === 0) return;
        e.preventDefault();
        const forward = key === "n" || key === "N";
        const len = flatDrivers.length;
        const startIdx = flatDrivers.findIndex((d) => d.kfiId === kfiId);
        const base = startIdx === -1 ? (forward ? -1 : 0) : startIdx;
        let target: string | null = null;
        for (let step = 1; step <= len; step++) {
          const probe = ((base + (forward ? step : -step)) % len + len) % len;
          if (!flatDrivers[probe].reviewed) {
            target = flatDrivers[probe].kfiId;
            break;
          }
        }
        if (!target) {
          toast({ title: "All drivers reviewed for this week" });
          return;
        }
        setLocation(`/weeks/${weekStart}/drivers/${target}`);
        return;
      }
      if (key === "r" || key === "R") {
        if (!data) return;
        e.preventDefault();
        const newVal = !data.reviewed;
        setReviewed.mutate(
          { weekStart, kfiId, data: { reviewed: newVal } },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
              queryClient.invalidateQueries({ queryKey: getGetWeekSummaryQueryKey(weekStart) });
              if (newVal && autoAdvance) advanceToNextUnreviewed();
            },
          },
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    flatDriverIds,
    flatDrivers,
    kfiId,
    weekStart,
    setLocation,
    isManualModalOpen,
    shortcutsOpen,
    data,
    setReviewed,
    queryClient,
    toast,
    autoAdvance,
  ]);

  // Find the next unreviewed driver after the current one in sidebar order,
  // skipping the current driver (which we've just toggled to reviewed). The
  // weekSummary cache may still report the current driver as un-reviewed
  // because the invalidation hasn't refetched yet, so we exclude it
  // explicitly. Returns null if every other driver is already reviewed.
  const findNextUnreviewedAfter = (currentId: string): string | null => {
    if (flatDrivers.length === 0) return null;
    const len = flatDrivers.length;
    const startIdx = flatDrivers.findIndex((d) => d.kfiId === currentId);
    const base = startIdx === -1 ? -1 : startIdx;
    for (let step = 1; step <= len; step++) {
      const probe = (((base + step) % len) + len) % len;
      const d = flatDrivers[probe];
      if (d.kfiId === currentId) continue;
      if (!d.reviewed) return d.kfiId;
    }
    return null;
  };

  const advanceToNextUnreviewed = () => {
    const next = findNextUnreviewedAfter(kfiId);
    if (next) {
      setLocation(`/weeks/${weekStart}/drivers/${next}`);
    } else {
      toast({ title: "All drivers reviewed for this week" });
    }
  };

  const toggleReviewed = () => {
    if (!data) return;
    const newVal = !data.reviewed;
    setReviewed.mutate(
      { weekStart, kfiId, data: { reviewed: newVal } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          queryClient.invalidateQueries({ queryKey: getGetWeekSummaryQueryKey(weekStart) });
          if (newVal && autoAdvance) advanceToNextUnreviewed();
        },
      },
    );
  };

  const handleCreateManual = () => {
    if (!manualClockIn || !manualClockOut || !manualDate) {
      toast({ title: "Validation", description: "Date, Clock In, and Clock Out are required.", variant: "destructive" });
      return;
    }
    if (manualSource === "Customer" && !manualCustomer) {
      toast({ title: "Validation", description: "Pick a customer for a Customer-source punch.", variant: "destructive" });
      return;
    }
    createPunch.mutate(
      {
        weekStart,
        data: {
          kfiId,
          date: manualDate,
          source: manualSource,
          customer: manualSource === "Customer" ? manualCustomer : null,
          clockIn: manualClockIn,
          clockOut: manualClockOut,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          setIsManualModalOpen(false);
          setManualClockIn("");
          setManualClockOut("");
          toast({ title: "Punch added" });
        },
        onError: (err) => {
          toast({ title: "Error", description: errMsg(err, "Failed to add punch"), variant: "destructive" });
        },
      },
    );
  };

  const startEdit = (p: Punch) => {
    setEditingPunchId(p.id);
    setEditClockIn(p.clockIn);
    setEditClockOut(p.clockOut);
  };

  const cancelEdit = () => {
    setEditingPunchId(null);
  };

  const saveEdit = (id: number) => {
    editPunch.mutate(
      { id, data: { clockIn: editClockIn, clockOut: editClockOut } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          setEditingPunchId(null);
          toast({ title: "Punch updated" });
        },
        onError: (err) => {
          toast({ title: "Error", description: errMsg(err, "Failed to update punch"), variant: "destructive" });
        },
      },
    );
  };

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this punch?")) return;
    deletePunch.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDriverWeekQueryKey(weekStart, kfiId) });
          toast({ title: "Punch deleted" });
        },
        onError: (err) => {
          toast({ title: "Error", description: errMsg(err, "Failed to delete punch"), variant: "destructive" });
        },
      },
    );
  };

  if (isLoading || isError || !data) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-background">
        <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center gap-4 shadow-sm">
          <DriversSidebarMobileTrigger
            weekStart={weekStart}
            selectedKfiId={kfiId}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          />
          <Link href={`/weeks/${weekStart}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            Week of <span className="font-mono">{weekStart}</span>
          </h1>
        </header>
        <div className="flex-1 flex min-h-0">
          <DriversSidebar
            weekStart={weekStart}
            selectedKfiId={kfiId}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
          />
          <main className="flex-1 flex items-center justify-center p-8">
            {isLoading ? (
              <Loader2 className="h-8 w-8 animate-spin" />
            ) : (
              <p className="text-destructive">Failed to load driver data.</p>
            )}
          </main>
        </div>
      </div>
    );
  }

  // Chronological sort using the same parser the server hours engine uses, so
  // the running-total split aligns with regularHours / overtimeHours.
  const sortedPunches = [...data.punches].sort((a, b) => {
    const ta = localStrToSortMs(a.clockIn) ?? isoDateToUtcMs(a.date);
    const tb = localStrToSortMs(b.clockIn) ?? isoDateToUtcMs(b.date);
    return ta - tb;
  });

  // Client-side running totals + OT split, mirroring hoursEngine.computeDriverTotals.
  let running = 0;
  const rows = sortedPunches.map((p) => {
    const before = running;
    const h = Number(p.hours) || 0;
    running = before + h;
    // Per-row split: OT for this row = OT cumulative-after minus OT cumulative-before.
    const otBefore = Math.max(0, before - OT_THRESHOLD);
    const otAfter = Math.max(0, running - OT_THRESHOLD);
    const otPortion = otAfter - otBefore;
    const rtPortion = h - otPortion;
    // Highlight rows whose cumulative hours cross or sit at/past the 40h line.
    const isOt = otPortion > 0.0001 || running >= OT_THRESHOLD - 0.0001;
    return { p, before, after: running, hours: h, rtPortion, otPortion, isOt };
  });

  const customerLabel = isCustomerNameUseful(data.driver.customer)
    ? data.driver.customer
    : "Needs roster cleanup";

  // Bar scale: 40 + a buffer so OT shows as visibly past the line.
  const scaleMax = Math.max(OT_THRESHOLD * 1.1, running * 1.02, OT_THRESHOLD + 4);
  const otLinePct = (OT_THRESHOLD / scaleMax) * 100;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-2.5 flex items-center justify-between shadow-sm print:hidden">
        <div className="flex items-center gap-3">
          <DriversSidebarMobileTrigger
            weekStart={weekStart}
            selectedKfiId={kfiId}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          />
          <Link href={`/weeks/${weekStart}`}>
            <Button variant="ghost" size="sm" className="h-8 text-sidebar-foreground hover:bg-sidebar-accent gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center space-x-2 bg-sidebar-accent/40 px-3 py-1.5 rounded-md">
            <Checkbox id="reviewed" checked={data.reviewed} onCheckedChange={toggleReviewed} />
            <label htmlFor="reviewed" className="text-sm font-medium leading-none cursor-pointer">
              Reviewed
            </label>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshCt.isPending}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          >
            {refreshCt.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setIsManualModalOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Punch
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.print()}
            title="Print timesheet"
            data-testid="button-print-timesheet"
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (?)"
            data-testid="button-show-shortcuts"
            className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <Keyboard className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="print:hidden contents">
          <DriversSidebar
            weekStart={weekStart}
            selectedKfiId={kfiId}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
          />
        </div>

        <main className="print-sheet flex-1 p-6 max-w-7xl mx-auto w-full space-y-6 overflow-x-hidden print:p-0 print:max-w-none print:mx-0 print:overflow-visible print:space-y-4">
        {/* Title block */}
        <div className="space-y-2">
          <h1 className="font-display font-bold text-3xl tracking-tight leading-none">
            {data.driver.name}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">
            Customer: <span className="text-foreground">{customerLabel}</span>
            <span className="mx-2 text-muted-foreground/60">·</span>
            KFI ID: <span className="text-foreground">{data.driver.kfiId}</span>
            <span className="hidden print:inline">
              <span className="mx-2 text-muted-foreground/60">·</span>
              Week of <span className="text-foreground">{weekStart}</span>
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground pt-1 print:hidden">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400" />
              Driver (ConnectTeam)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-400" />
              Customer (Timesheet)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-warning" />
              Overtime threshold
            </span>
          </div>
        </div>


        {data.checks.length > 0 && (
          <Card className="border-warning bg-warning/5">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm text-warning flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> Validation Alerts
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ul className="space-y-1 text-sm text-warning-foreground">
                {data.checks.map((chk, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-mono text-xs opacity-70 w-24 shrink-0">{chk.date || "General"}</span>
                    <span>{chk.message}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Compact stat cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <StatCard
            label="Driver Hours"
            value={data.totals.driverHours}
            valueClass="text-blue-600 dark:text-blue-400"
          />
          <StatCard
            label="Customer Hours"
            value={data.totals.customerHours}
            valueClass="text-emerald-600 dark:text-emerald-400"
          />
          <StatCard label="Total Hours" value={data.totals.totalHours} />
          <StatCard
            label="Regular (RT)"
            value={data.totals.regularHours}
            valueClass="text-emerald-700 dark:text-emerald-400"
          />
          <StatCard
            label="Overtime (OT)"
            value={data.totals.overtimeHours}
            valueClass="text-warning"
            cardClass="border-warning/40"
          />
        </div>

        {/* Punch table */}
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px] uppercase text-[11px] tracking-wider">Date</TableHead>
                  <TableHead className="w-[110px] uppercase text-[11px] tracking-wider">Source</TableHead>
                  <TableHead className="uppercase text-[11px] tracking-wider">Clock In</TableHead>
                  <TableHead className="uppercase text-[11px] tracking-wider">Clock Out</TableHead>
                  <TableHead className="text-right uppercase text-[11px] tracking-wider w-[80px]">Hours</TableHead>
                  <TableHead className="uppercase text-[11px] tracking-wider min-w-[220px]">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1 min-w-[120px] h-4">
                        <div
                          className="absolute top-0 bottom-0 w-px bg-warning/70"
                          style={{ left: `${otLinePct}%` }}
                        />
                        <span
                          className="absolute -top-0.5 text-[9px] font-mono font-semibold text-warning tracking-tight whitespace-nowrap -translate-x-1/2"
                          style={{ left: `${otLinePct}%` }}
                        >
                          40h OT
                        </span>
                      </div>
                      <span className="w-12 text-right normal-case tracking-wider">Running</span>
                    </div>
                  </TableHead>
                  <TableHead className="text-right uppercase text-[11px] tracking-wider w-[100px]">Type</TableHead>
                  <TableHead className="text-right w-[90px] print:hidden"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                      No punches recorded for this week.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map(({ p, before, after, isOt, rtPortion, otPortion }) => {
                  const isEditing = editingPunchId === p.id;
                  const isDriver = p.source === "Driver";
                  const rtPctOfRow = (rtPortion / scaleMax) * 100;
                  const otPctOfRow = (otPortion / scaleMax) * 100;
                  // Within "before", how much was already RT vs OT (for the lighter "completed" portion).
                  const beforeRtPct = (Math.min(before, OT_THRESHOLD) / scaleMax) * 100;
                  const beforeOtPct = (Math.max(0, before - OT_THRESHOLD) / scaleMax) * 100;
                  const remaining = OT_THRESHOLD - after;
                  const tooltipLine =
                    remaining > 0.0001
                      ? `${remaining.toFixed(2)}h until OT`
                      : remaining < -0.0001
                        ? `${Math.abs(remaining).toFixed(2)}h over OT`
                        : `at the 40h OT line`;
                  return (
                    <TableRow
                      key={p.id}
                      className={cn(isOt && "bg-warning/10 hover:bg-warning/15")}
                    >
                      <TableCell className="font-mono text-sm whitespace-nowrap">{p.date}</TableCell>
                      <TableCell>
                        <SourceBadge source={p.source} />
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {p.isManual && (
                            <span className="text-[9px] uppercase tracking-wider px-1 py-0 rounded border border-border text-muted-foreground">
                              Manual
                            </span>
                          )}
                          {p.edited && (
                            <span className="text-[9px] uppercase tracking-wider px-1 py-0 rounded border border-border text-muted-foreground">
                              Edited
                            </span>
                          )}
                        </div>
                        {(p.updatedByEmail || p.createdByEmail) && (
                          <div
                            className="text-[10px] font-mono text-muted-foreground/80 mt-0.5 truncate max-w-[140px]"
                            title={p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ""}
                          >
                            {p.edited && p.updatedByEmail
                              ? `edited by ${p.updatedByEmail}`
                              : p.createdByEmail
                                ? `by ${p.createdByEmail}`
                                : ""}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        {isEditing ? (
                          <Input
                            className="h-8 w-40 font-mono text-sm"
                            value={editClockIn}
                            onChange={(e) => setEditClockIn(e.target.value)}
                          />
                        ) : (
                          formatClockCell(p.clockIn)
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        {isEditing ? (
                          <Input
                            className="h-8 w-40 font-mono text-sm"
                            value={editClockOut}
                            onChange={(e) => setEditClockOut(e.target.value)}
                          />
                        ) : (
                          formatClockCell(p.clockOut)
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium">{p.hours.toFixed(2)}</TableCell>
                      <TableCell>
                        <TooltipProvider delayDuration={150}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-2 cursor-help">
                                <div className="relative h-1.5 flex-1 min-w-[120px] bg-muted rounded-full overflow-hidden print:hidden">
                                  {/* "Already accumulated" lighter base */}
                                  {beforeRtPct > 0 && (
                                    <div
                                      className="absolute top-0 left-0 h-full bg-blue-300/60 dark:bg-blue-400/30"
                                      style={{ width: `${beforeRtPct}%` }}
                                    />
                                  )}
                                  {beforeOtPct > 0 && (
                                    <div
                                      className="absolute top-0 h-full bg-warning/40"
                                      style={{ left: `${otLinePct}%`, width: `${beforeOtPct}%` }}
                                    />
                                  )}
                                  {/* This-row RT portion */}
                                  {rtPctOfRow > 0 && (
                                    <div
                                      className={cn(
                                        "absolute top-0 h-full",
                                        isDriver ? "bg-blue-700 dark:bg-blue-400" : "bg-emerald-600 dark:bg-emerald-400",
                                      )}
                                      style={{ left: `${beforeRtPct}%`, width: `${rtPctOfRow}%` }}
                                    />
                                  )}
                                  {/* This-row OT portion */}
                                  {otPctOfRow > 0 && (
                                    <div
                                      className="absolute top-0 h-full bg-warning"
                                      style={{
                                        left: `${otLinePct + beforeOtPct}%`,
                                        width: `${otPctOfRow}%`,
                                      }}
                                    />
                                  )}
                                  {/* OT threshold marker */}
                                  <div
                                    className="absolute top-0 h-full w-px bg-warning/70"
                                    style={{ left: `${otLinePct}%` }}
                                  />
                                </div>
                                <span
                                  className={cn(
                                    "font-mono text-xs tabular-nums w-12 text-right",
                                    isOt ? "text-warning" : "text-muted-foreground",
                                  )}
                                >
                                  {after.toFixed(2)}
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="font-mono text-[11px] leading-relaxed">
                              <div>Cumulative: {after.toFixed(2)}h</div>
                              <div>{tooltipLine}</div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-medium text-sm",
                          isDriver
                            ? "text-blue-600 dark:text-blue-400"
                            : "text-emerald-600 dark:text-emerald-400",
                        )}
                      >
                        {p.source}
                      </TableCell>
                      <TableCell className="text-right print:hidden">
                        {isEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={() => saveEdit(p.id)}>
                              <Save className="h-3 w-3" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={cancelEdit}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1 opacity-60 hover:opacity-100">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              onClick={() => startEdit(p)}
                            >
                              <Edit2 className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => handleDelete(p.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
        </main>
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2 py-2">
            <ShortcutRow keys={["j", "↓"]} label="Next driver" />
            <ShortcutRow keys={["k", "↑"]} label="Previous driver" />
            <ShortcutRow keys={["n"]} label="Next unreviewed driver" />
            <ShortcutRow keys={["p"]} label="Previous unreviewed driver" />
            <ShortcutRow keys={["r"]} label="Toggle reviewed" />
            <ShortcutRow keys={["?"]} label="Show this help" />
            <div className="flex items-center justify-between gap-4 pt-3 mt-2 border-t border-border">
              <label
                htmlFor="auto-advance-pref"
                className="text-foreground cursor-pointer"
              >
                Jump to next unreviewed after marking reviewed
              </label>
              <Checkbox
                id="auto-advance-pref"
                checked={autoAdvance}
                onCheckedChange={(v) => setAutoAdvance(v === true)}
                data-testid="checkbox-auto-advance"
              />
            </div>
            <p className="text-xs text-muted-foreground pt-2">
              Shortcuts are ignored while typing in a field or while a dialog is open.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isManualModalOpen} onOpenChange={setIsManualModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Manual Punch</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Date</Label>
              <Input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Source</Label>
              <Select value={manualSource} onValueChange={(val) => setManualSource(val as "Driver" | "Customer")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Driver">Driver</SelectItem>
                  <SelectItem value="Customer">Customer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {manualSource === "Customer" && (
              <div className="grid gap-2">
                <Label>Customer</Label>
                <Select value={manualCustomer} onValueChange={setManualCustomer}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KNOWN_CUSTOMERS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Clock In</Label>
                <Input placeholder="7:30 AM" value={manualClockIn} onChange={(e) => setManualClockIn(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>Clock Out</Label>
                <Input placeholder="3:45 PM" value={manualClockOut} onChange={(e) => setManualClockOut(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Format as "H:MM AM/PM" (e.g. "8:00 AM")</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsManualModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateManual} disabled={createPunch.isPending}>
              {createPunch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Punch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueClass,
  cardClass,
}: {
  label: string;
  value: number;
  valueClass?: string;
  cardClass?: string;
}) {
  return (
    <Card className={cn("py-0", cardClass)}>
      <CardContent className="px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {label}
        </div>
        <div className={cn("text-2xl font-mono font-bold leading-tight mt-1 tabular-nums", valueClass)}>
          {value.toFixed(2)}
        </div>
      </CardContent>
    </Card>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-foreground">{label}</span>
      <div className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="px-1.5 py-0.5 rounded border border-border bg-muted font-mono text-xs min-w-[1.5rem] text-center"
          >
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: "Driver" | "Customer" | string }) {
  const isDriver = source === "Driver";
  return (
    <span
      className={cn(
        "inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-sm",
        isDriver
          ? "bg-sidebar text-sidebar-foreground"
          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
      )}
    >
      {source}
    </span>
  );
}
