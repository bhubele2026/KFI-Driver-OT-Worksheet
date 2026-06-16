import { useState } from "react";
import { useLocation, Link, useParams } from "wouter";
import {
  useGetWeekSummary,
  useGetCustomerUploadStatus,
  useListWeeks,
  useRefreshConnecteam,
  useResetWeek,
  getGetWeekSummaryQueryKey,
  getGetCustomerUploadStatusQueryKey,
  useLogout,
  useGetMe,
  getGetMeQueryKey,
  useGetZenopleReadiness,
  getDownloadZenopleExportUrl,
} from "@workspace/api-client-react";
import { CustomerUploadPanel } from "@/components/customer-upload-panel";
import { ZenopleExportButton } from "@/components/zenople-export-button";
import { DriversSidebar, DriversSidebarMobileTrigger } from "@/components/drivers-sidebar";
import { ReviewedPill } from "@/components/reviewed-pill";
import {
  AllReviewedSplash,
  FullyReconciledSplash,
} from "@/components/all-reviewed-splash";
import {
  useAllReviewedCelebration,
  useFullyReconciledCelebration,
} from "@/hooks/use-all-reviewed-celebration";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  RefreshCw,
  UploadCloud,
  AlertTriangle,
  LogOut,
  ChevronRight,
  ChevronLeft,
  Printer,
  Lock,
  Trash2,
  Globe,
} from "lucide-react";
import { AdminLink } from "@/components/admin-link";
import { HiddenNotesBadge } from "@/components/hidden-notes-badge";
import { LanguageToggle } from "@/components/language-toggle";
import { PresenceChip } from "@/components/presence-chip";
import { useLiveUpdates } from "@/hooks/use-live-updates";
import { usePresence } from "@/hooks/use-presence";
import { Logo } from "@/components/logo";
import { useTranslation } from "react-i18next";
import {
  format,
  parseISO,
  isValid,
  previousSunday,
  isSunday,
  addWeeks,
} from "date-fns";

function getSunday(d: Date) {
  const date = new Date(d);
  const day = date.getDay(); // 0 = Sunday
  date.setDate(date.getDate() - day);
  return date;
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

function useT() { return useTranslation().t; }

export default function WeekSummary() {
  const t = useT();
  const params = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const { data: me } = useGetMe();

  const today = new Date();
  const currentSunday = getSunday(today);
  const defaultWeekStart = format(currentSunday, "yyyy-MM-dd");

  const weekStart = params.weekStart || defaultWeekStart;

  useLiveUpdates({
    weekStart,
    selfEmail: me?.email ?? null,
    enableToasts: true,
  });
  const viewers = usePresence({ weekStart });

  const { data: weeksList } = useListWeeks();

  // Dropdown shows every Sun→Sat week from the Sun→Sat cutover
  // (2026-05-10) through the current payroll week, plus any DB-known
  // weeks (in case data exists for a week outside that range) and the
  // currently-selected week. No future-only weeks; the list grows
  // naturally as time advances.
  const weekOptions = (() => {
    const endOf = (sundayIso: string) => {
      const d = parseISO(sundayIso);
      d.setDate(d.getDate() + 6);
      return format(d, "yyyy-MM-dd");
    };
    const FIRST_WEEK = "2026-05-10";
    const map = new Map<string, { startDate: string; endDate: string }>();
    let cursor = parseISO(FIRST_WEEK);
    const end = currentSunday;
    while (cursor.getTime() <= end.getTime()) {
      const s = format(cursor, "yyyy-MM-dd");
      map.set(s, { startDate: s, endDate: endOf(s) });
      cursor = addWeeks(cursor, 1);
    }
    for (const w of weeksList ?? []) {
      map.set(w.startDate, { startDate: w.startDate, endDate: w.endDate });
    }
    if (!map.has(weekStart)) {
      map.set(weekStart, { startDate: weekStart, endDate: endOf(weekStart) });
    }
    return [...map.values()].sort((a, b) =>
      a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0,
    );
  })();
  // Task #401: dashboard navigates between drivers frequently; a 30s
  // staleTime keeps the network panel quiet while still letting any
  // explicit mutation (refresh, upload, edit) invalidate immediately.
  const { data: summary, isLoading, isError, error } =
    useGetWeekSummary(weekStart, {
      query: {
        staleTime: 30_000,
        queryKey: getGetWeekSummaryQueryKey(weekStart),
      },
    });
  const { data: uploadStatuses, isFetched: uploadStatusesFetched } =
    useGetCustomerUploadStatus(weekStart, {
      query: {
        staleTime: 30_000,
        queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
      },
    });

  const allDrivers = summary?.customers.flatMap((c) => c.drivers) ?? [];
  const reviewedCount = allDrivers.filter((d) => d.reviewed).length;
  const overtimeCount = allDrivers.filter((d) => d.overtimeHours > 0).length;

  // "Outstanding alerts" mirrors what the dashboard surfaces inline:
  //   - per-driver driver-vs-customer hours mismatch (> 0.05h)
  //   - per-driver Connecteam parity differ
  //   - any customer upload with unmapped badge / employee IDs
  //   - stale Connecteam baseline (no refresh in >6h, matches the
  //     server-side CT_BASELINE_STALE_HOURS default)
  // Used by `useFullyReconciledCelebration` to detect the moment the week
  // crosses from "still work to do" to "actually done".
  const STALE_BASELINE_HOURS = 6;
  const hasMismatchAlert = allDrivers.some((d) => {
    if (d.driverHours <= 0 || d.customerHours <= 0) return false;
    return Math.abs(d.driverHours - d.customerHours) > 0.05;
  });
  const hasParityDifferAlert = allDrivers.some(
    (d) => d.connecteamParity?.status === "differ",
  );
  const hasUnmappedAlert = (uploadStatuses ?? []).some(
    (s) => (s.lastUnmappedIds?.length ?? 0) > 0,
  );
  const baselineStale = (() => {
    if (!summary) return false;
    if (!summary.lastRefreshedAt) return true;
    const ageMs = Date.now() - new Date(summary.lastRefreshedAt).getTime();
    return ageMs > STALE_BASELINE_HOURS * 3_600_000;
  })();
  const alertCount =
    (hasMismatchAlert ? 1 : 0) +
    (hasParityDifferAlert ? 1 : 0) +
    (hasUnmappedAlert ? 1 : 0) +
    (baselineStale ? 1 : 0);
  const fullyReconciled =
    allDrivers.length > 0 &&
    reviewedCount >= allDrivers.length &&
    alertCount === 0;
  const reconciliationReady =
    !!summary && allDrivers.length > 0 && uploadStatusesFetched;

  const { splashVisible, dismiss: dismissSplash } = useAllReviewedCelebration({
    weekStart,
    reviewed: reviewedCount,
    total: allDrivers.length,
    surface: "week-summary",
  });
  const {
    splashVisible: fullyReconciledSplashVisible,
    dismiss: dismissFullyReconciledSplash,
  } = useFullyReconciledCelebration({
    weekStart,
    fullyReconciled,
    ready: reconciliationReady,
    surface: "week-summary",
  });

  const refreshCt = useRefreshConnecteam();
  const resetWeekMut = useResetWeek();
  const [sidebarCollapsed, , toggleSidebar] = useSidebarCollapsed();

  const [lastRefreshIssues, setLastRefreshIssues] = useState<{
    unresolved: Array<{ ctUserId: number; shiftCount: number; clockIds: number[] }>;
    failures: Array<{ clockId: number; clockName: string; error: string }>;
  } | null>(null);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetScope, setResetScope] = useState<
    "punches-only" | "punches-and-reviewed" | "all"
  >("punches-only");
  const [resetConfirmText, setResetConfirmText] = useState("");

  const openResetDialog = () => {
    setResetScope("punches-only");
    setResetConfirmText("");
    setResetOpen(true);
  };

  const handleReset = () => {
    resetWeekMut.mutate(
      { weekStart, data: { scope: resetScope, confirm: resetConfirmText } },
      {
        onSuccess: (data) => {
          setResetOpen(false);
          setResetConfirmText("");
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          queryClient.invalidateQueries({
            queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
          });
          toast({
            title: t("weekSummary.weekResetTitle"),
            description:
              t("weekSummary.weekResetPunches", { count: data.punchesDeleted }) +
              (data.reviewedDeleted > 0
                ? t("weekSummary.weekResetReviews", { count: data.reviewedDeleted })
                : "") +
              (data.notesSoftDeleted > 0
                ? t("weekSummary.weekResetNotes", { count: data.notesSoftDeleted })
                : "") +
              ".",
          });
        },
        onError: (err) => {
          const e = err as unknown as {
            status?: number;
            data?: { error?: string; lockedKfiIds?: string[] };
          };
          if (e.status === 409 && e.data?.lockedKfiIds?.length) {
            toast({
              title: t("weekSummary.resetBlockedTitle"),
              description: t("weekSummary.resetBlockedDesc", { ids: e.data.lockedKfiIds.join(", ") }),
              variant: "destructive",
            });
          } else {
            toast({
              title: t("weekSummary.resetFailedTitle"),
              description: errMessage(err, t("weekSummary.resetCouldNot")),
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  const goWeek = (delta: number) => {
    const base = parseISO(weekStart);
    const target = addWeeks(base, delta);
    setLocation(`/weeks/${format(target, "yyyy-MM-dd")}`);
  };

  const handleRefresh = () => {
    refreshCt.mutate(
      { weekStart },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
          queryClient.invalidateQueries({
            queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
          });
          toast({
            title: t("weekSummary.refreshSuccessTitle"),
            description: t("weekSummary.refreshSuccessDesc", { drivers: data.driversFound, punches: data.punchesUpserted }),
          });
          if (data.clockFailures && data.clockFailures.length > 0) {
            toast({
              title: t("weekSummary.refreshClockFailuresTitle", { count: data.clockFailures.length }),
              description: data.clockFailures
                .map((f) => `${f.clockName} (${f.clockId}): ${f.error}`)
                .join(" · "),
              variant: "destructive",
            });
          }
          setLastRefreshIssues({
            unresolved: data.unresolvedUsers ?? [],
            failures: data.clockFailures ?? [],
          });
        },
        onError: (err) => {
          toast({
            title: t("weekSummary.refreshFailedTitle"),
            description: errMessage(err, t("weekSummary.refreshFailedDesc")),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setLocation("/login");
      },
    });
  };

  const handleWeekChange = (val: string) => {
    setLocation(`/weeks/${val}`);
  };

  const handleCustomWeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val && isValid(parseISO(val))) {
      const d = parseISO(val);
      const s = isSunday(d) ? d : previousSunday(d);
      setLocation(`/weeks/${format(s, "yyyy-MM-dd")}`);
    }
  };

  const openReport = () => {
    window.open(
      `${import.meta.env.BASE_URL}api/weeks/${weekStart}/report`,
      "_blank",
      "noopener",
    );
  };

  const openTimesheets = (params?: {
    filter?: "reviewed" | "overtime" | "alerts";
    customer?: string;
    format?: "pdf";
  }) => {
    const qs = new URLSearchParams();
    if (params?.filter) qs.set("filter", params.filter);
    if (params?.customer) qs.set("customer", params.customer);
    if (params?.format) qs.set("format", params.format);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    window.open(
      `${import.meta.env.BASE_URL}api/weeks/${weekStart}/timesheets${tail}`,
      "_blank",
      "noopener",
    );
  };

  const printableCustomers = (summary?.customers ?? [])
    .map((c) => ({
      customer: c.customer,
      driverCount: c.drivers.length,
    }))
    .filter((c) => c.driverCount > 0);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <DriversSidebarMobileTrigger
            weekStart={weekStart}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          />
          <Link
            href="/"
            className="flex items-center no-underline"
            title="KFI Workforce Deployment"
          >
            <Logo />
          </Link>
          <div className="h-6 w-px bg-sidebar-border/60" />
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => goWeek(-1)}
              title={t("header.previousWeek")}
              className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => goWeek(1)}
              title={t("header.nextWeek")}
              className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Select value={weekStart} onValueChange={handleWeekChange}>
              <SelectTrigger className="w-[200px] h-8 bg-sidebar-accent border-sidebar-accent-border text-sidebar-accent-foreground text-sm font-mono">
                <SelectValue placeholder={t("header.selectWeek")} />
              </SelectTrigger>
              <SelectContent>
                {weekOptions.map((w) => (
                  <SelectItem
                    key={w.startDate}
                    value={w.startDate}
                    className="font-mono"
                  >
                    {t("weekSummary.weekRangeOption", { start: w.startDate, end: w.endDate })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              title={t("header.jumpTo")}
              className="w-36 h-8 bg-sidebar-accent border-sidebar-accent-border text-sidebar-accent-foreground font-mono text-sm [color-scheme:dark]"
              onChange={handleCustomWeekChange}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <PresenceChip viewers={viewers} selfEmail={me?.email ?? null} />
          <HiddenNotesBadge variant="compact" />
          <LanguageToggle />
          <AdminLink />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
          >
            <LogOut className="h-4 w-4 mr-2" />
            {t("common.signOut")}
          </Button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <DriversSidebar
          weekStart={weekStart}
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
        />

        <main className="flex-1 px-5 py-5 max-w-[1700px] mx-auto w-full space-y-5 overflow-x-hidden relative">
          {lastRefreshIssues &&
            (lastRefreshIssues.unresolved.length > 0 ||
              lastRefreshIssues.failures.length > 0) && (
              <div
                role="alert"
                className="rounded-md border border-amber-500/60 bg-amber-500/10 p-4 text-sm space-y-2"
                data-testid="banner-refresh-issues"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-display font-semibold text-amber-900 dark:text-amber-200">
                    {t("weekSummary.refreshIssuesBanner")}
                  </div>
                  <button
                    type="button"
                    className="text-xs underline text-muted-foreground"
                    onClick={() => setLastRefreshIssues(null)}
                  >
                    {t("common.dismiss")}
                  </button>
                </div>
                {lastRefreshIssues.failures.length > 0 && (
                  <div className="text-xs">
                    <span className="font-semibold">
                      {t("weekSummary.refreshIssuesClocksFailed", { count: lastRefreshIssues.failures.length })}
                    </span>{" "}
                    <span className="font-mono">
                      {lastRefreshIssues.failures
                        .map((f) => `${f.clockName} (${f.clockId})`)
                        .join(", ")}
                    </span>
                  </div>
                )}
                {lastRefreshIssues.unresolved.length > 0 && (
                  <div className="text-xs space-y-1">
                    <div>
                      <span className="font-semibold">
                        {t("weekSummary.refreshIssuesUnresolved", { count: lastRefreshIssues.unresolved.length })}
                      </span>{" "}
                      <span className="font-mono">
                        {lastRefreshIssues.unresolved
                          .slice(0, 5)
                          .map((u) => `${u.ctUserId} (${u.shiftCount})`)
                          .join(", ")}
                        {lastRefreshIssues.unresolved.length > 5 ? " …" : ""}
                      </span>
                    </div>
                    <Link
                      href="/admin/connecteam-user-aliases"
                      className="text-xs underline text-amber-900 dark:text-amber-200"
                    >
                      {t("weekSummary.refreshIssuesMapLink")}
                    </Link>
                  </div>
                )}
              </div>
            )}
          <AllReviewedSplash visible={splashVisible} onDismiss={dismissSplash} />
          <FullyReconciledSplash
            visible={fullyReconciledSplashVisible}
            onDismiss={dismissFullyReconciledSplash}
          />
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-2xl font-bold font-display tracking-tight text-foreground">
                  {t("weekSummary.weekHeading", { week: weekStart })}
                </h2>
                {summary ? (
                  <ReviewedPill
                    reviewed={reviewedCount}
                    total={allDrivers.length}
                    testId="pill-week-reviewed-progress"
                  />
                ) : null}
              </div>
              {summary?.lastRefreshedAt ? (
                <p className="text-sm text-muted-foreground">
                  {t("weekSummary.lastRefresh")}{" "}
                  <span className="font-mono">
                    {new Date(summary.lastRefreshedAt).toLocaleString()}
                  </span>
                  {summary.lastRefreshedByEmail && (
                    <span className="ml-2">
                      {t("weekSummary.lastRefreshBy")}{" "}
                      <span className="font-mono">
                        {summary.lastRefreshedByEmail}
                      </span>
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("weekSummary.noData")}
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Button variant="outline" onClick={openReport}>
                <Printer className="mr-2 h-4 w-4" />
                {t("weekSummary.downloadReport")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    data-testid="button-print-week-timesheets"
                  >
                    <Printer className="mr-2 h-4 w-4" />
                    {t("weekSummary.printTimesheets")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("weekSummary.printPreviewHtml")}
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={() => openTimesheets()}
                    data-testid="menuitem-print-all-drivers"
                  >
                    {t("weekSummary.allDrivers")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openTimesheets({ filter: "reviewed" })}
                    disabled={reviewedCount === 0}
                    data-testid="menuitem-print-reviewed-only"
                  >
                    {t("weekSummary.reviewedOnly", { count: reviewedCount })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openTimesheets({ filter: "overtime" })}
                    disabled={overtimeCount === 0}
                    data-testid="menuitem-print-overtime-only"
                  >
                    {t("weekSummary.overtimeOnly", { count: overtimeCount })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openTimesheets({ filter: "alerts" })}
                    data-testid="menuitem-print-alerts-only"
                  >
                    {t("weekSummary.withAlerts")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("weekSummary.downloadPdf")}
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={() => openTimesheets({ format: "pdf" })}
                    data-testid="menuitem-pdf-all-drivers"
                  >
                    {t("weekSummary.allDriversPdf")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      openTimesheets({ filter: "reviewed", format: "pdf" })
                    }
                    disabled={reviewedCount === 0}
                    data-testid="menuitem-pdf-reviewed-only"
                  >
                    {t("weekSummary.reviewedOnlyPdf", { count: reviewedCount })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      openTimesheets({ filter: "overtime", format: "pdf" })
                    }
                    disabled={overtimeCount === 0}
                    data-testid="menuitem-pdf-overtime-only"
                  >
                    {t("weekSummary.overtimeOnlyPdf", { count: overtimeCount })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      openTimesheets({ filter: "alerts", format: "pdf" })
                    }
                    data-testid="menuitem-pdf-alerts-only"
                  >
                    {t("weekSummary.withAlertsPdf")}
                  </DropdownMenuItem>
                  {printableCustomers.length > 0 ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t("weekSummary.byCustomer")}
                      </DropdownMenuLabel>
                      {printableCustomers.map((c) => (
                        <DropdownMenuItem
                          key={c.customer}
                          onSelect={() =>
                            openTimesheets({ customer: c.customer })
                          }
                          data-testid={`menuitem-print-customer-${c.customer}`}
                        >
                          <span className="truncate">{c.customer}</span>
                          <span className="ml-auto text-xs text-muted-foreground font-mono">
                            {t("weekSummary.htmlBadge", { count: c.driverCount })}
                          </span>
                        </DropdownMenuItem>
                      ))}
                      {printableCustomers.map((c) => (
                        <DropdownMenuItem
                          key={`${c.customer}-pdf`}
                          onSelect={() =>
                            openTimesheets({
                              customer: c.customer,
                              format: "pdf",
                            })
                          }
                          data-testid={`menuitem-pdf-customer-${c.customer}`}
                        >
                          <span className="truncate">{c.customer}</span>
                          <span className="ml-auto text-xs text-muted-foreground font-mono">
                            {t("weekSummary.pdfBadge", { count: c.driverCount })}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button onClick={handleRefresh} disabled={refreshCt.isPending}>
                {refreshCt.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {t("weekSummary.refreshConnecteam")}
              </Button>
              {me?.isAdmin ? (
                <>
                  <ZenopleExportButton weekStart={weekStart} />
                  <Button
                    variant="destructive"
                    onClick={openResetDialog}
                    data-testid="button-open-reset-week"
                    disabled={resetWeekMut.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("weekSummary.resetWeek")}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
            <AlertDialogContent data-testid="dialog-reset-week">
              <AlertDialogHeader>
                <AlertDialogTitle>{t("weekSummary.resetDialogTitle", { week: weekStart })}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("weekSummary.resetDialogDesc")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <RadioGroup
                value={resetScope}
                onValueChange={(v) =>
                  setResetScope(
                    v as "punches-only" | "punches-and-reviewed" | "all",
                  )
                }
                className="gap-3 py-2"
              >
                <div className="flex items-start gap-3">
                  <RadioGroupItem
                    value="punches-only"
                    id="reset-scope-punches"
                    className="mt-1"
                    data-testid="radio-reset-scope-punches-only"
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="reset-scope-punches" className="font-medium">
                      {t("weekSummary.resetScopePunches")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("weekSummary.resetScopePunchesDesc")}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <RadioGroupItem
                    value="punches-and-reviewed"
                    id="reset-scope-reviewed"
                    className="mt-1"
                    data-testid="radio-reset-scope-punches-and-reviewed"
                  />
                  <div className="space-y-0.5">
                    <Label
                      htmlFor="reset-scope-reviewed"
                      className="font-medium"
                    >
                      {t("weekSummary.resetScopeReviewed")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("weekSummary.resetScopeReviewedDesc")}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <RadioGroupItem
                    value="all"
                    id="reset-scope-all"
                    className="mt-1"
                    data-testid="radio-reset-scope-all"
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="reset-scope-all" className="font-medium">
                      {t("weekSummary.resetScopeAll")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("weekSummary.resetScopeAllDesc")}
                    </p>
                  </div>
                </div>
              </RadioGroup>
              <div className="space-y-1.5">
                <Label
                  htmlFor="reset-confirm"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  {t("weekSummary.resetTypePrefix")} <span className="font-mono">{weekStart}</span> {t("weekSummary.resetTypeSuffix")}
                </Label>
                <Input
                  id="reset-confirm"
                  value={resetConfirmText}
                  onChange={(e) => setResetConfirmText(e.target.value)}
                  placeholder={weekStart}
                  className="font-mono"
                  data-testid="input-reset-confirm"
                  autoComplete="off"
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel
                  disabled={resetWeekMut.isPending}
                  data-testid="button-reset-cancel"
                >
                  {t("common.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    handleReset();
                  }}
                  disabled={
                    resetConfirmText !== weekStart || resetWeekMut.isPending
                  }
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="button-reset-confirm"
                >
                  {resetWeekMut.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  {t("weekSummary.resetWeekButton")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {isLoading ? (
            <div className="py-12 flex justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : isError ? (
            <Card className="border-destructive">
              <CardContent className="pt-6">
                <div className="flex flex-col items-center justify-center text-center space-y-2">
                  <AlertTriangle className="h-8 w-8 text-destructive" />
                  <p className="text-destructive font-medium">
                    {errMessage(error, t("weekSummary.loadWeekFailed"))}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : summary ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs text-muted-foreground uppercase font-semibold">
                      {t("weekSummary.stats.activeDrivers")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold font-mono">
                      {summary.totals.activeDrivers}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs text-muted-foreground uppercase font-semibold">
                      {t("weekSummary.stats.totalHours")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold font-mono">
                      {summary.totals.totalHours.toFixed(2)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs text-muted-foreground uppercase font-semibold">
                      {t("weekSummary.stats.driverSource")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400">
                      {summary.totals.driverHours.toFixed(2)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs text-muted-foreground uppercase font-semibold">
                      {t("weekSummary.stats.customerSource")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                      {summary.totals.customerHours.toFixed(2)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs text-muted-foreground uppercase font-semibold">
                      {t("weekSummary.stats.regular")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold font-mono">
                      {summary.totals.regularHours.toFixed(2)}
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-warning/50 bg-warning/5">
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs text-warning uppercase font-semibold">
                      {t("weekSummary.stats.overtime")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold font-mono text-warning">
                      {summary.totals.overtimeHours.toFixed(2)}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="review-totals-chips"
              >
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium border bg-card text-foreground border-border"
                  data-testid="chip-review-totals"
                >
                  <span className="text-emerald-700 dark:text-emerald-300">
                    {t("weekSummary.totals.good", { count: (summary.totals as { goodCount?: number }).goodCount ?? 0 })}
                  </span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-rose-700 dark:text-rose-300">
                    {t("weekSummary.totals.bad", { count: (summary.totals as { badCount?: number }).badCount ?? 0 })}
                  </span>
                  <span className="text-muted-foreground">/</span>
                  <span>
                    {t("weekSummary.totals.total", { count: summary.totals.activeDrivers })}
                  </span>
                </span>
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium border bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
                  data-testid="chip-locked-count"
                >
                  <Lock className="h-3 w-3" />
                  {t("weekSummary.totals.locked", { count: (summary.totals as { lockedCount?: number }).lockedCount ?? 0 })}
                </span>
              </div>

              <CustomerUploadPanel weekStart={weekStart} />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

