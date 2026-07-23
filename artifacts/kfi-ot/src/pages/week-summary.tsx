import { useState } from "react";
import { useLocation, Link, useParams } from "wouter";
import {
  useGetWeekSummary,
  useGetCustomerUploadStatus,
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
import { ZenopleExportButton } from "@/components/zenople-export-button";
import { DriversSidebar } from "@/components/drivers-sidebar";
import { AppShell } from "@/components/app-shell";
import { WeekToolbar } from "@/components/week-toolbar";
import { StatTile } from "@/components/stat-tile";
import { useCountUp } from "@/hooks/use-count-up";
import { payWeekStart } from "@/lib/pay-week";
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
  MoreHorizontal,
  Flag,
  Users,
  Download,
  Check,
  X as XIcon,
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
  addDays,
} from "date-fns";

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
  // Payroll is reconciled after the week ends, so default to last week (the
  // most-recently-completed pay week), not the in-progress current week.
  const defaultWeekStart = payWeekStart(today);

  const weekStart = params.weekStart || defaultWeekStart;

  useLiveUpdates({
    weekStart,
    selfEmail: me?.email ?? null,
    enableToasts: true,
  });
  const viewers = usePresence({ weekStart });

  // The week picker + its bounded option list live in <WeekToolbar>.
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
    <AppShell active="/timesheets" wide>
      <div className="mx-auto w-full max-w-[1700px] px-5 pt-4">
        <WeekToolbar
          weekStart={weekStart}
          onChange={(w) => setLocation(`/timesheets/${w}`)}
        />
      </div>

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
                className="tile border-l-4 border-l-warning p-4 text-sm space-y-2"
                data-testid="banner-refresh-issues"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-display font-semibold text-foreground">
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
                    <span className="fin-num">
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
                      <span className="fin-num">
                        {lastRefreshIssues.unresolved
                          .slice(0, 5)
                          .map((u) => `${u.ctUserId} (${u.shiftCount})`)
                          .join(", ")}
                        {lastRefreshIssues.unresolved.length > 5 ? " …" : ""}
                      </span>
                    </div>
                    <Link
                      href="/admin/connecteam-user-aliases"
                      className="text-xs font-medium text-primary underline underline-offset-2"
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
          <div className="rise-in flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-2xl font-bold font-display tracking-tight text-foreground">
                  {t("weekSummary.weekHeading", {
                    week: `${format(parseISO(weekStart), "MMM d")} – ${format(addDays(parseISO(weekStart), 6), "MMM d, yyyy")}`,
                  })}
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
                <p
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                  title={`${t("weekSummary.lastRefresh")} ${new Date(summary.lastRefreshedAt).toLocaleString()}${summary.lastRefreshedByEmail ? ` ${t("weekSummary.lastRefreshBy")} ${summary.lastRefreshedByEmail}` : ""}`}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span className="fin-num">
                    {new Date(summary.lastRefreshedAt).toLocaleString()}
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("weekSummary.noData")}
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="outline"
                size="icon"
                onClick={openReport}
                title={t("weekSummary.downloadReport")}
              >
                <Download className="h-4 w-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    data-testid="button-print-week-timesheets"
                    title={t("weekSummary.printTimesheets")}
                  >
                    <Printer className="h-4 w-4" />
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
                          <span className="ml-auto text-xs text-muted-foreground fin-num">
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
                          <span className="ml-auto text-xs text-muted-foreground fin-num">
                            {t("weekSummary.pdfBadge", { count: c.driverCount })}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="icon"
                onClick={handleRefresh}
                disabled={refreshCt.isPending}
                title={t("weekSummary.refreshConnecteam")}
              >
                {refreshCt.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
              {me?.isAdmin ? (
                <>
                  <ZenopleExportButton weekStart={weekStart} />
                  {/* Destructive week reset lives behind the overflow menu so
                      a red button isn't part of the everyday toolbar. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        data-testid="button-week-overflow"
                        title={t("weekSummary.moreActions", { defaultValue: "More actions" })}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem
                        onSelect={openResetDialog}
                        disabled={resetWeekMut.isPending}
                        data-testid="button-open-reset-week"
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t("weekSummary.resetWeek")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
                  {t("weekSummary.resetTypePrefix")} <span className="fin-num">{weekStart}</span> {t("weekSummary.resetTypeSuffix")}
                </Label>
                <Input
                  id="reset-confirm"
                  value={resetConfirmText}
                  onChange={(e) => setResetConfirmText(e.target.value)}
                  placeholder={weekStart}
                  className="fin-num"
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
              <div className="stagger grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <StatTile
                  label={t("weekSummary.stats.activeDrivers")}
                  value={summary.totals.activeDrivers}
                  decimals={0}
                />
                <StatTile
                  label={t("weekSummary.stats.totalHours")}
                  value={summary.totals.totalHours}
                />
                <StatTile
                  label={t("weekSummary.stats.driverSource")}
                  value={summary.totals.driverHours}
                  tone="text-brand-navy"
                />
                <StatTile
                  label={t("weekSummary.stats.customerSource")}
                  value={summary.totals.customerHours}
                />
                <StatTile
                  label={t("weekSummary.stats.regular")}
                  value={summary.totals.regularHours}
                />
                <StatTile
                  label={t("weekSummary.stats.overtime")}
                  value={summary.totals.overtimeHours}
                  highlight
                />
              </div>

              <div
                className="rise-in flex flex-wrap items-center gap-2"
                data-testid="review-totals-chips"
              >
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs fin-num font-medium border bg-card text-foreground border-border"
                  data-testid="chip-review-totals"
                >
                  <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-300">
                    <Check className="h-3 w-3" />
                    {t("weekSummary.totals.good", { count: (summary.totals as { goodCount?: number }).goodCount ?? 0 })}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="inline-flex items-center gap-0.5 text-rose-700 dark:text-rose-300">
                    <XIcon className="h-3 w-3" />
                    {t("weekSummary.totals.bad", { count: (summary.totals as { badCount?: number }).badCount ?? 0 })}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>
                    {t("weekSummary.totals.total", { count: summary.totals.activeDrivers })}
                  </span>
                </span>
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs fin-num font-medium border bg-card text-muted-foreground border-border"
                  data-testid="chip-locked-count"
                >
                  <Lock className="h-3 w-3" />
                  {t("weekSummary.totals.locked", { count: (summary.totals as { lockedCount?: number }).lockedCount ?? 0 })}
                </span>
              </div>

              {/* Customers at a glance — fills the page with the week's real
                  status instead of dead space. Each tile jumps into that
                  customer's first driver. Pure derivation from `summary`. */}
              {summary.customers.some((c) => c.drivers.length > 0) ? (
                <section className="space-y-3">
                  <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {summary.customers
                      .filter((c) => c.drivers.length > 0)
                      .map((c) => {
                        const hours = c.drivers.reduce((a, d) => a + d.totalHours, 0);
                        const ot = c.drivers.reduce((a, d) => a + d.overtimeHours, 0);
                        const reviewedN = c.drivers.filter((d) => d.reviewed).length;
                        const flagged = c.drivers.reduce(
                          (a, d) => a + (d.flaggedPunchCount ?? 0),
                          0,
                        );
                        const lockedN = c.drivers.filter((d) => d.locked).length;
                        const noCtN = c.drivers.filter(
                          (d) => d.customerHours > 0 && d.driverHours <= 0,
                        ).length;
                        const pct =
                          c.drivers.length > 0
                            ? Math.round((reviewedN / c.drivers.length) * 100)
                            : 0;
                        return (
                          <button
                            key={c.customer}
                            type="button"
                            className="tile-action flex flex-col gap-3 p-5 text-left"
                            data-testid={`tile-customer-${c.customer}`}
                            onClick={() =>
                              setLocation(
                                `/weeks/${weekStart}/drivers/${c.drivers[0].kfiId}`,
                              )
                            }
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="truncate font-display text-base font-semibold text-foreground">
                                {c.customer}
                              </span>
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs fin-num text-muted-foreground">
                                <Users className="h-3 w-3" />
                                {c.drivers.length}
                              </span>
                            </div>
                            <div className="flex items-baseline gap-4">
                              <span>
                                <AnimatedHours value={hours} />{" "}
                                <span className="text-xs text-muted-foreground">
                                  {t("weekSummary.tileHours", { defaultValue: "hrs" })}
                                </span>
                              </span>
                              {ot > 0 ? (
                                <span className="fin-num text-sm font-semibold text-warning">
                                  {t("weekSummary.tileOt", {
                                    defaultValue: "{{hours}} OT",
                                    hours: ot.toFixed(2),
                                  })}
                                </span>
                              ) : null}
                              {noCtN > 0 ? (
                                <span
                                  className="inline-flex items-center gap-1 fin-num text-sm font-semibold text-warning"
                                  title={t("weekSummary.tileNoCtTitle", { count: noCtN })}
                                >
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  {t("weekSummary.tileNoCt", { count: noCtN })}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-auto space-y-1.5">
                              <div className="flex items-center justify-between text-xs">
                                <span className="inline-flex items-center gap-1 fin-num text-muted-foreground">
                                  <Check className="h-3 w-3" />
                                  {t("weekSummary.tileReviewed", {
                                    n: reviewedN,
                                    total: c.drivers.length,
                                  })}
                                </span>
                                <span className="flex items-center gap-2">
                                  {flagged > 0 ? (
                                    <span className="inline-flex items-center gap-1 fin-num text-rose-600">
                                      <Flag className="h-3 w-3" />
                                      {flagged}
                                    </span>
                                  ) : null}
                                  {lockedN > 0 ? (
                                    <span className="inline-flex items-center gap-1 fin-num text-muted-foreground">
                                      <Lock className="h-3 w-3" />
                                      {lockedN}
                                    </span>
                                  ) : null}
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                <div
                                  className={`grow-bar h-full rounded-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-primary"}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </main>
      </div>
    </AppShell>
  );
}


/** Count-up hours figure for the customer tiles ("appear live" pass). */
function AnimatedHours({ value }: { value: number }) {
  const animated = useCountUp(value);
  return (
    <span className="fin-num text-2xl font-semibold text-foreground">
      {animated.toFixed(2)}
    </span>
  );
}
