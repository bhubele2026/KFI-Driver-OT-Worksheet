import { useState } from "react";
import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useGetAllowedTimezones,
  useListCustomerTzPreferences,
  useUpsertCustomerTzPreference,
  useDeleteCustomerTzPreference,
  useGetWeekSummary,
  useUpdateDriverTimezone,
  getListCustomerTzPreferencesQueryKey,
  getGetWeekSummaryQueryKey,
} from "@workspace/api-client-react";
import type { DriverSummaryRow } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Globe, Loader2, Plus, Trash2 } from "lucide-react";
import { Logo } from "@/components/logo";
import { format } from "date-fns";

const DEFAULT_TZ_FALLBACK = "America/Chicago";

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

function isoWeekStart(d: Date): string {
  const dt = new Date(d);
  const day = dt.getUTCDay();
  const diff = (day + 6) % 7; // Monday=0
  dt.setUTCDate(dt.getUTCDate() - diff);
  return dt.toISOString().slice(0, 10);
}

export default function AdminTimezones() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: allowed } = useGetAllowedTimezones();
  const { data: prefs, isLoading: prefsLoading } = useListCustomerTzPreferences(
    {
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListCustomerTzPreferencesQueryKey(),
      },
    },
  );
  const upsert = useUpsertCustomerTzPreference();
  const del = useDeleteCustomerTzPreference();

  const weekStart = isoWeekStart(new Date());
  const { data: weekSummary } = useGetWeekSummary(weekStart, {
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getGetWeekSummaryQueryKey(weekStart),
    },
  });
  const updateDriverTz = useUpdateDriverTimezone();

  const [newCustomer, setNewCustomer] = useState("");
  const [newTz, setNewTz] = useState<string>(DEFAULT_TZ_FALLBACK);

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const tzOptions = allowed?.allowed ?? [DEFAULT_TZ_FALLBACK];

  const preferences = prefs?.preferences ?? [];
  const knownCustomers = prefs?.knownCustomers ?? [];
  const prefByLowerCustomer = new Map(
    preferences.map((p) => [p.customer.toLowerCase(), p]),
  );
  // Show every known customer first (always-visible audit list), then any
  // extras that have a saved preference but aren't in KNOWN_CUSTOMERS
  // (typically AI-only customers seeded via /confirm-new-customer).
  const knownLower = new Set(knownCustomers.map((c) => c.toLowerCase()));
  const extras = preferences.filter(
    (p) => !knownLower.has(p.customer.toLowerCase()),
  );
  const customerRows: Array<{
    customer: string;
    isKnown: boolean;
    pref: (typeof preferences)[number] | undefined;
  }> = [
    ...knownCustomers.map((customer) => ({
      customer,
      isKnown: true,
      pref: prefByLowerCustomer.get(customer.toLowerCase()),
    })),
    ...extras
      .slice()
      .sort((a, b) =>
        a.customer.toLowerCase().localeCompare(b.customer.toLowerCase()),
      )
      .map((pref) => ({ customer: pref.customer, isKnown: false, pref })),
  ];

  const invalidatePrefs = () =>
    qc.invalidateQueries({
      queryKey: getListCustomerTzPreferencesQueryKey(),
    });
  const invalidateWeek = () =>
    qc.invalidateQueries({
      queryKey: getGetWeekSummaryQueryKey(weekStart),
    });

  const addPref = () => {
    const customer = newCustomer.trim();
    if (!customer) return;
    upsert.mutate(
      { data: { customer, displayTz: newTz } },
      {
        onSuccess: () => {
          setNewCustomer("");
          invalidatePrefs();
          toast({
            title: "Preference saved",
            description: `${customer} → ${newTz}`,
          });
        },
        onError: (err) =>
          toast({
            title: "Save failed",
            description: errMessage(err, "Unknown error"),
            variant: "destructive",
          }),
      },
    );
  };

  const changeCustomerTz = (customer: string, displayTz: string) => {
    upsert.mutate(
      { data: { customer, displayTz } },
      {
        onSuccess: () => {
          invalidatePrefs();
          toast({
            title: "Updated",
            description: `${customer} → ${displayTz}`,
          });
        },
        onError: (err) =>
          toast({
            title: "Update failed",
            description: errMessage(err, "Unknown error"),
            variant: "destructive",
          }),
      },
    );
  };

  const removePref = (customer: string) => {
    del.mutate(
      { params: { customer } },
      {
        onSuccess: () => {
          invalidatePrefs();
          toast({ title: "Cleared", description: customer });
        },
        onError: (err) =>
          toast({
            title: "Clear failed",
            description: errMessage(err, "Unknown error"),
            variant: "destructive",
          }),
      },
    );
  };

  const changeDriverTz = (kfiId: string, name: string, tz: string | null) => {
    updateDriverTz.mutate(
      { kfiId, data: { displayTz: tz } },
      {
        onSuccess: () => {
          invalidateWeek();
          toast({
            title: "Driver tz updated",
            description: `${name} → ${tz ?? "(default)"}`,
          });
        },
        onError: (err) =>
          toast({
            title: "Update failed",
            description: errMessage(err, "Unknown error"),
            variant: "destructive",
          }),
      },
    );
  };

  const drivers = (weekSummary?.customers ?? []).flatMap((g) =>
    g.drivers.map((d: DriverSummaryRow) => ({
      kfiId: d.kfiId,
      name: d.name,
      customer: g.customer,
      displayTz: d.displayTz ?? null,
      effectiveDispTz: d.effectiveDispTz ?? DEFAULT_TZ_FALLBACK,
    })),
  );

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/" title="KFI Staffing" className="no-underline">
            <Logo />
          </Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href="/admin/users">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to users
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Timezones
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-6xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base">
              Per-customer default timezone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              When uploading a customer file, the parser stamps each row in this
              timezone unless the dispatcher picks a per-upload override or a
              driver has their own override.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">
                  Customer
                </label>
                <Input
                  value={newCustomer}
                  onChange={(e) => setNewCustomer(e.target.value)}
                  placeholder="Adient, IWG, Penda…"
                  className="h-8 w-56"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">
                  Timezone
                </label>
                <Select value={newTz} onValueChange={setNewTz}>
                  <SelectTrigger className="h-8 w-[200px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tzOptions.map((tz) => (
                      <SelectItem key={tz} value={tz} className="text-xs">
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                onClick={addPref}
                disabled={upsert.isPending || !newCustomer.trim()}
              >
                {upsert.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-1" />
                )}
                Save
              </Button>
            </div>

            {prefsLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Timezone</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customerRows.map((row) => {
                    const p = row.pref;
                    const hasPref = !!p;
                    return (
                      <TableRow key={`${row.isKnown ? "known" : "extra"}:${row.customer}`}>
                        <TableCell className="font-medium text-sm">
                          <div className="flex items-center gap-2">
                            <span>{row.customer}</span>
                            {!row.isKnown ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] font-normal"
                              >
                                AI-only
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={hasPref ? p!.displayTz : "__default__"}
                            onValueChange={(v) => {
                              if (v === "__default__") {
                                if (hasPref) removePref(row.customer);
                              } else {
                                changeCustomerTz(row.customer, v);
                              }
                            }}
                          >
                            <SelectTrigger className="h-7 w-[220px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem
                                value="__default__"
                                className="text-xs"
                              >
                                (driver default)
                              </SelectItem>
                              {tzOptions.map((tz) => (
                                <SelectItem
                                  key={tz}
                                  value={tz}
                                  className="text-xs"
                                >
                                  {tz}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                          {hasPref
                            ? format(new Date(p!.updatedAt), "yyyy-MM-dd HH:mm")
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {hasPref ? p!.updatedByEmail ?? "—" : "—"}
                        </TableCell>
                        <TableCell>
                          {hasPref ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => removePref(row.customer)}
                              disabled={del.isPending}
                              title="Clear preference"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base">
              Per-driver overrides
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              A driver's override wins over the customer preference and the
              system default. Use "(default)" to clear and fall back to the
              customer / system default.
            </p>
            {drivers.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No drivers loaded for the current week yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Override</TableHead>
                    <TableHead>Effective</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drivers.map((d) => (
                    <TableRow key={d.kfiId}>
                      <TableCell className="text-sm">
                        <div className="font-medium">{d.name}</div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {d.kfiId}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {d.customer}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={d.displayTz ?? "__default__"}
                          onValueChange={(v) =>
                            changeDriverTz(
                              d.kfiId,
                              d.name,
                              v === "__default__" ? null : v,
                            )
                          }
                        >
                          <SelectTrigger className="h-7 w-[200px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem
                              value="__default__"
                              className="text-xs"
                            >
                              (default)
                            </SelectItem>
                            {tzOptions.map((tz) => (
                              <SelectItem
                                key={tz}
                                value={tz}
                                className="text-xs"
                              >
                                {tz}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {d.effectiveDispTz}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
