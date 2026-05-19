import { useState } from "react";
import { formatPersonName } from "@/lib/format-name";
import { useLocation, Link, useParams } from "wouter";
import {
  useGetWeekSummary,
  useListWeeks,
  useRefreshConnecteam,
  getGetWeekSummaryQueryKey,
  getGetCustomerUploadStatusQueryKey,
  useLogout,
  useGetMe,
  getGetMeQueryKey,
  useSetReviewed,
} from "@workspace/api-client-react";
import { CustomerUploadPanel } from "@/components/customer-upload-panel";
import { DriversSidebar, DriversSidebarMobileTrigger } from "@/components/drivers-sidebar";
import { ReviewedPill } from "@/components/reviewed-pill";
import { AllReviewedSplash } from "@/components/all-reviewed-splash";
import { useAllReviewedCelebration } from "@/hooks/use-all-reviewed-celebration";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
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
  XCircle,
  StickyNote,
  Check,
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
  const { data: summary, isLoading, isError, error } =
    useGetWeekSummary(weekStart);

  const allDrivers = summary?.customers.flatMap((c) => c.drivers) ?? [];
  const reviewedCount = allDrivers.filter((d) => d.reviewed).length;
  const overtimeCount = allDrivers.filter((d) => d.overtimeHours > 0).length;

  const { splashVisible, dismiss: dismissSplash } = useAllReviewedCelebration({
    weekStart,
    reviewed: reviewedCount,
    total: allDrivers.length,
    surface: "week-summary",
  });

  const refreshCt = useRefreshConnecteam();
  const setReviewed = useSetReviewed();
  const [sidebarCollapsed, , toggleSidebar] = useSidebarCollapsed();

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

  const toggleReviewed = (kfiId: string, currentVal: boolean) => {
    setReviewed.mutate(
      { weekStart, kfiId, data: { reviewed: !currentVal } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetWeekSummaryQueryKey(weekStart),
          });
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
            className="flex items-center gap-2.5 no-underline"
            title={`KFI Staffing — ${t("header.appTitle")}`}
          >
            <Logo />
            <span className="hidden lg:inline text-[11px] uppercase tracking-[0.18em] text-sidebar-foreground/60 font-display">
              {t("header.appTitle")}
            </span>
          </Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
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
                    {w.startDate} to {w.endDate}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <span className="text-xs text-sidebar-foreground/60">
                {t("header.jumpTo")}
              </span>
              <Input
                type="date"
                className="w-36 h-8 bg-sidebar-accent border-sidebar-accent-border text-sidebar-accent-foreground font-mono text-sm dark:[color-scheme:dark]"
                onChange={handleCustomWeekChange}
              />
            </div>
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

        <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6 overflow-x-hidden relative">
          <AllReviewedSplash visible={splashVisible} onDismiss={dismissSplash} />
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-2xl font-bold font-display tracking-tight text-foreground">
                  Week of {weekStart}
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
                            HTML · {c.driverCount}
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
                            PDF · {c.driverCount}
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
            </div>
          </div>

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
                    {errMessage(error, "Failed to load week summary")}
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

              <div className="space-y-6">
                {summary.customers.length === 0 ? (
                  <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                      {t("weekSummary.noActiveDrivers")}
                    </CardContent>
                  </Card>
                ) : (
                  summary.customers.map((group) => (
                    <Card
                      key={group.customer}
                      className="overflow-hidden border-border/60 shadow-sm"
                    >
                      <div className="bg-muted/40 px-4 py-3 border-b border-border">
                        <h3 className="font-display font-semibold text-lg flex items-center gap-2 flex-wrap">
                          {group.customer}
                          <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                            {t("weekSummary.table.drivers", { count: group.drivers.length })}
                          </span>
                          <ReviewedPill
                            reviewed={
                              group.drivers.filter((d) => d.reviewed).length
                            }
                            total={group.drivers.length}
                            testId={`pill-customer-reviewed-${group.customer}`}
                          />
                        </h3>
                      </div>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/10 hover:bg-muted/10">
                              <TableHead className="w-[200px]">
                                {t("weekSummary.table.driver")}
                              </TableHead>
                              <TableHead className="text-right">
                                {t("weekSummary.table.driverHrs")}
                              </TableHead>
                              <TableHead className="text-right">
                                {t("weekSummary.table.custHrs")}
                              </TableHead>
                              <TableHead className="text-right">{t("weekSummary.table.diff")}</TableHead>
                              <TableHead className="text-right">{t("weekSummary.table.reg")}</TableHead>
                              <TableHead className="text-right">{t("weekSummary.table.ot")}</TableHead>
                              <TableHead className="text-xs">
                                {t("weekSummary.table.lastTouched")}
                              </TableHead>
                              <TableHead className="text-center w-[100px]">
                                {t("weekSummary.table.reviewed")}
                              </TableHead>
                              <TableHead className="w-[50px]"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.drivers.map((driver) => {
                              const diff = Math.abs(
                                driver.driverHours - driver.customerHours,
                              );
                              const hasMismatch =
                                driver.driverHours > 0 &&
                                driver.customerHours > 0 &&
                                diff > 0.05;

                              return (
                                <TableRow key={driver.kfiId} className="group">
                                  <TableCell className="font-medium">
                                    <div className="flex flex-col">
                                      <span className="truncate flex items-center gap-1.5">
                                        {formatPersonName(driver.name)}
                                        {driver.noteCount > 0 && (
                                          <Link
                                            href={`/weeks/${weekStart}/drivers/${driver.kfiId}#notes`}
                                            className="inline-flex items-center gap-0.5 text-[10px] font-mono text-primary bg-primary/10 hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 px-1 py-0.5 rounded transition-colors cursor-pointer"
                                            title={t("weekSummary.table.noteCount", { count: driver.noteCount })}
                                            aria-label={t("weekSummary.table.noteCount", { count: driver.noteCount })}
                                            data-testid={`badge-note-count-${driver.kfiId}`}
                                          >
                                            <StickyNote className="h-2.5 w-2.5" />
                                            {driver.noteCount}
                                          </Link>
                                        )}
                                        {driver.connecteamParity?.status === "match" ? (
                                          <span
                                            className="inline-flex items-center gap-0.5 text-[10px] font-mono text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-1 py-0.5 rounded"
                                            title="Every day's dashboard total reconciles to the Connecteam baseline within 0.005h."
                                            data-testid={`badge-ct-parity-match-${driver.kfiId}`}
                                          >
                                            <Check className="h-2.5 w-2.5" />
                                            CT
                                          </span>
                                        ) : driver.connecteamParity?.status === "differ" ? (
                                          <span
                                            className="inline-flex items-center gap-0.5 text-[10px] font-mono text-warning bg-warning/15 border border-warning/40 px-1 py-0.5 rounded"
                                            title={`${driver.connecteamParity.diffCount} day${driver.connecteamParity.diffCount === 1 ? "" : "s"} diverge from the Connecteam baseline. Open the driver to see which.`}
                                            data-testid={`badge-ct-parity-diff-${driver.kfiId}`}
                                          >
                                            <AlertTriangle className="h-2.5 w-2.5" />
                                            CT {driver.connecteamParity.diffCount}
                                          </span>
                                        ) : null}
                                      </span>
                                      <span className="text-xs text-muted-foreground font-mono">
                                        {driver.kfiId}
                                      </span>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-blue-600 dark:text-blue-400">
                                    {driver.driverHours > 0
                                      ? driver.driverHours.toFixed(2)
                                      : "-"}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-emerald-600 dark:text-emerald-400">
                                    {driver.customerHours > 0
                                      ? driver.customerHours.toFixed(2)
                                      : "-"}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {hasMismatch ? (
                                      <span className="inline-flex items-center gap-1 text-destructive font-mono bg-destructive/10 px-1.5 py-0.5 rounded text-xs font-semibold">
                                        <AlertTriangle className="h-3 w-3" />
                                        {diff.toFixed(2)}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground font-mono">
                                        -
                                      </span>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right font-mono">
                                    {driver.regularHours.toFixed(2)}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {driver.overtimeHours > 0 ? (
                                      <span className="font-mono text-warning font-semibold">
                                        {driver.overtimeHours.toFixed(2)}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground font-mono">
                                        -
                                      </span>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                                    {driver.lastTouchedByEmail ? (
                                      <span title={driver.lastTouchedAt ? new Date(driver.lastTouchedAt).toLocaleString() : ""}>
                                        {driver.lastTouchedByEmail}
                                      </span>
                                    ) : (
                                      "—"
                                    )}
                                  </TableCell>
                                  <TableCell className="text-center">
                                    <div
                                      className="inline-flex items-center justify-center gap-1.5"
                                      data-testid={`driver-status-${driver.kfiId}`}
                                    >
                                      {driver.reviewStatus === "bad" ? (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            toggleReviewed(driver.kfiId, true)
                                          }
                                          title={t("weekSummary.status.markedBadClear")}
                                          data-testid={`status-bad-${driver.kfiId}`}
                                          className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 rounded px-1.5 py-0.5"
                                        >
                                          <XCircle className="h-4 w-4" />
                                          <span className="text-[10px] font-mono uppercase">
                                            {t("weekSummary.status.bad")}
                                          </span>
                                        </button>
                                      ) : (
                                        <Checkbox
                                          checked={driver.reviewed}
                                          onCheckedChange={() =>
                                            toggleReviewed(
                                              driver.kfiId,
                                              driver.reviewed,
                                            )
                                          }
                                          aria-label={
                                            driver.reviewed
                                              ? t("weekSummary.status.markedGoodClear")
                                              : t("weekSummary.status.markGood")
                                          }
                                          data-testid={`checkbox-reviewed-${driver.kfiId}`}
                                        />
                                      )}
                                      {driver.locked && (
                                        <span
                                          className="inline-flex items-center text-amber-600 dark:text-amber-400"
                                          data-testid={`status-locked-${driver.kfiId}`}
                                          title={
                                            driver.lockedByEmail
                                              ? t("weekSummary.status.lockedBy", { email: driver.lockedByEmail })
                                              : t("weekSummary.status.lockedShort")
                                          }
                                        >
                                          <Lock className="h-3.5 w-3.5" />
                                        </span>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Link
                                      href={`/weeks/${weekStart}/drivers/${driver.kfiId}`}
                                    >
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                      >
                                        <ChevronRight className="h-4 w-4" />
                                      </Button>
                                    </Link>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </Card>
                  ))
                )}
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
