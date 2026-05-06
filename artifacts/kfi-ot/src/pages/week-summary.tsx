import { useState } from "react";
import { useLocation, Link, useParams } from "wouter";
import {
  useGetWeekSummary,
  useListWeeks,
  useRefreshConnecteam,
  getGetWeekSummaryQueryKey,
  getGetCustomerUploadStatusQueryKey,
  useLogout,
  getGetMeQueryKey,
  useSetReviewed,
} from "@workspace/api-client-react";
import { CustomerUploadPanel } from "@/components/customer-upload-panel";
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
  CheckCircle2,
  Circle,
} from "lucide-react";
import { AdminLink } from "@/components/admin-link";
import {
  format,
  parseISO,
  isValid,
  previousMonday,
  isMonday,
  addWeeks,
} from "date-fns";

function getMonday(d: Date) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

export default function WeekSummary() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const logout = useLogout();

  const today = new Date();
  const currentMonday = getMonday(today);
  const defaultWeekStart = format(currentMonday, "yyyy-MM-dd");

  const weekStart = params.weekStart || defaultWeekStart;

  const { data: weeksList } = useListWeeks();
  const { data: summary, isLoading, isError, error } =
    useGetWeekSummary(weekStart);

  const refreshCt = useRefreshConnecteam();
  const setReviewed = useSetReviewed();

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
            title: "Connecteam Refreshed",
            description: `Found ${data.driversFound} drivers, updated ${data.punchesUpserted} punches.`,
          });
        },
        onError: (err) => {
          toast({
            title: "Refresh failed",
            description: errMessage(err, "Failed to pull from Connecteam"),
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
            title: "Error",
            description: "Failed to update review status",
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
      const m = isMonday(d) ? d : previousMonday(d);
      setLocation(`/weeks/${format(m, "yyyy-MM-dd")}`);
    }
  };

  const openReport = () => {
    window.open(
      `${import.meta.env.BASE_URL}api/weeks/${weekStart}/report`,
      "_blank",
      "noopener",
    );
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="font-display font-bold text-lg tracking-tight">
            KFI OT Worksheet
          </h1>
          <div className="h-4 w-px bg-sidebar-border" />
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => goWeek(-1)}
              title="Previous week"
              className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => goWeek(1)}
              title="Next week"
              className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Select value={weekStart} onValueChange={handleWeekChange}>
              <SelectTrigger className="w-[200px] h-8 bg-sidebar-accent border-sidebar-accent-border text-sidebar-accent-foreground text-sm font-mono">
                <SelectValue placeholder="Select week" />
              </SelectTrigger>
              <SelectContent>
                {weeksList?.map((w) => (
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
                Or jump to:
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
          <AdminLink />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Left sidebar — drivers grouped by customer; double-click toggles reviewed */}
        <aside className="w-72 shrink-0 border-r border-border bg-muted/20 overflow-y-auto hidden md:block">
          <div className="px-4 py-3 border-b border-border bg-muted/40">
            <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
              Drivers by Customer
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1 leading-tight">
              Click a name to open · double-click to mark reviewed.
            </p>
          </div>
          {summary?.customers && summary.customers.length > 0 ? (
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
                    {group.drivers.map((driver) => (
                      <li key={driver.kfiId}>
                        <button
                          type="button"
                          onClick={() =>
                            setLocation(
                              `/weeks/${weekStart}/drivers/${driver.kfiId}`,
                            )
                          }
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            toggleReviewed(driver.kfiId, driver.reviewed);
                          }}
                          title="Click to open · Double-click to toggle reviewed"
                          className="w-full text-left px-4 py-1.5 text-sm flex items-center gap-2 hover:bg-accent hover:text-accent-foreground transition-colors group select-none"
                        >
                          {driver.reviewed ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          ) : (
                            <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                          )}
                          <span className="flex-1 truncate">
                            {driver.name}
                          </span>
                          {driver.overtimeHours > 0 && (
                            <span className="text-[10px] font-mono font-semibold text-warning bg-warning/10 px-1 rounded">
                              OT
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No drivers loaded. Click "Refresh Connecteam" to pull this week.
            </p>
          )}
        </aside>

        <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6 overflow-x-hidden relative">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold font-display tracking-tight text-foreground">
                Week of {weekStart}
              </h2>
              {summary?.lastRefreshedAt ? (
                <p className="text-sm text-muted-foreground">
                  Last CT Refresh:{" "}
                  <span className="font-mono">
                    {new Date(summary.lastRefreshedAt).toLocaleString()}
                  </span>
                  {summary.lastRefreshedByEmail && (
                    <span className="ml-2">
                      by{" "}
                      <span className="font-mono">
                        {summary.lastRefreshedByEmail}
                      </span>
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No Connecteam data yet for this week.
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Button variant="outline" onClick={openReport}>
                <Printer className="mr-2 h-4 w-4" />
                Download Report
              </Button>
              <Button onClick={handleRefresh} disabled={refreshCt.isPending}>
                {refreshCt.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh Connecteam
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
                      Active Drivers
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
                      Total Hours
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
                      Driver Source
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
                      Customer Source
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
                      Regular
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
                      Overtime
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold font-mono text-warning">
                      {summary.totals.overtimeHours.toFixed(2)}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <CustomerUploadPanel weekStart={weekStart} />

              <div className="space-y-6">
                {summary.customers.length === 0 ? (
                  <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                      No active drivers found for this week.
                    </CardContent>
                  </Card>
                ) : (
                  summary.customers.map((group) => (
                    <Card
                      key={group.customer}
                      className="overflow-hidden border-border/60 shadow-sm"
                    >
                      <div className="bg-muted/40 px-4 py-3 border-b border-border">
                        <h3 className="font-display font-semibold text-lg flex items-center gap-2">
                          {group.customer}
                          <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                            {group.drivers.length} drivers
                          </span>
                        </h3>
                      </div>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/10 hover:bg-muted/10">
                              <TableHead className="w-[200px]">
                                Driver
                              </TableHead>
                              <TableHead className="text-right">
                                Driver Hrs
                              </TableHead>
                              <TableHead className="text-right">
                                Cust Hrs
                              </TableHead>
                              <TableHead className="text-right">Diff</TableHead>
                              <TableHead className="text-right">Reg</TableHead>
                              <TableHead className="text-right">OT</TableHead>
                              <TableHead className="text-xs">
                                Last touched
                              </TableHead>
                              <TableHead className="text-center w-[100px]">
                                Reviewed
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
                                      <span className="truncate">
                                        {driver.name}
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
                                    <Checkbox
                                      checked={driver.reviewed}
                                      onCheckedChange={() =>
                                        toggleReviewed(
                                          driver.kfiId,
                                          driver.reviewed,
                                        )
                                      }
                                    />
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
