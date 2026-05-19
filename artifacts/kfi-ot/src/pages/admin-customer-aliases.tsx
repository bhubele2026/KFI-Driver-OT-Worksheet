import { Fragment, useMemo, useState } from "react";
import { formatPersonName } from "@/lib/format-name";
import { useTranslation } from "react-i18next";
import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListCustomerNameAliases,
  useUpdateCustomerNameAlias,
  useForgetCustomerNameAlias,
  useListCustomerAliasAuditLog,
  getListCustomerNameAliasesQueryKey,
  getListCustomerAliasAuditLogQueryKey,
  type CustomerNameAlias,
  type DriverInfo,
} from "@workspace/api-client-react";
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
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  History,
  Link as LinkIcon,
  Loader2,
  Trash2,
  Users,
} from "lucide-react";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { Logo } from "@/components/logo";

const STALE_AFTER_DAYS = 28;

type EditState = {
  customer: string;
  nameOnDoc: string;
  kfiId: string;
} | null;

export default function AdminCustomerAliases() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data, isLoading } = useListCustomerNameAliases({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListCustomerNameAliasesQueryKey(),
    },
  });

  const { data: auditLog, isLoading: auditLoading } =
    useListCustomerAliasAuditLog(
      { limit: 50 },
      {
        query: {
          enabled: !!me?.isAdmin,
          queryKey: getListCustomerAliasAuditLogQueryKey({ limit: 50 }),
        },
      },
    );

  const updateAlias = useUpdateCustomerNameAlias();
  const forgetAlias = useForgetCustomerNameAlias();

  const [edit, setEdit] = useState<EditState>(null);

  const grouped = useMemo(() => {
    const aliases = data?.aliases ?? [];
    const map = new Map<string, CustomerNameAlias[]>();
    for (const a of aliases) {
      const list = map.get(a.customer) ?? [];
      list.push(a);
      map.set(a.customer, list);
    }
    return [...map.entries()].sort((a, b) =>
      a[0].toLowerCase().localeCompare(b[0].toLowerCase()),
    );
  }, [data]);

  const drivers = useMemo(() => data?.drivers ?? [], [data]);

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const refetch = () => {
    qc.invalidateQueries({ queryKey: getListCustomerNameAliasesQueryKey() });
    qc.invalidateQueries({
      queryKey: [getListCustomerAliasAuditLogQueryKey({ limit: 50 })[0]],
    });
  };

  const handleSaveEdit = () => {
    if (!edit) return;
    updateAlias.mutate(
      {
        params: { customer: edit.customer, nameOnDoc: edit.nameOnDoc },
        data: { kfiId: edit.kfiId },
      },
      {
        onSuccess: () => {
          setEdit(null);
          refetch();
          toast({ title: "Alias re-mapped" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't update alias",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const handleForget = (a: CustomerNameAlias) => {
    forgetAlias.mutate(
      { params: { customer: a.customer, nameOnDoc: a.nameOnDoc } },
      {
        onSuccess: () => {
          refetch();
          toast({
            title: "Alias forgotten",
            description: `${a.customer} · ${a.nameOnDoc}`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't forget alias",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const totalAliases = data?.aliases.length ?? 0;
  const orphans =
    data?.aliases.filter((a) => a.driverName == null).length ?? 0;
  const archived =
    data?.aliases.filter((a) => a.driverIsArchived === true).length ?? 0;
  const today = new Date();
  const isStale = (lastUsedWeek: string | null | undefined) => {
    if (!lastUsedWeek) return true;
    const d = parseISO(lastUsedWeek);
    if (Number.isNaN(d.getTime())) return true;
    return differenceInCalendarDays(today, d) >= STALE_AFTER_DAYS;
  };
  const staleCount =
    data?.aliases.filter((a) => isStale(a.lastUsedWeek)).length ?? 0;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/" title="KFI Staffing" className="no-underline"><Logo /></Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href="/admin/users">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              {t("common.backToUsers")}
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            {t("adminAliases.title")}
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Users className="h-4 w-4" />
              Saved aliases
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Every (customer, name-on-doc) → driver mapping the
              "New customer file" flow has remembered. Re-map a row when a
              dispatcher made a wrong call, or forget it to let the next
              upload re-decide. Forgetting only removes the saved decision
              — it doesn't touch any imported punches.
            </p>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {totalAliases} total
              </Badge>
              {orphans > 0 && (
                <Badge variant="destructive" className="font-mono">
                  {orphans} pointing at deleted driver
                </Badge>
              )}
              {archived > 0 && (
                <Badge
                  variant="outline"
                  className="font-mono border-amber-500/50 text-amber-700 dark:text-amber-400"
                >
                  {archived} pointing at archived driver
                </Badge>
              )}
              {staleCount > 0 && (
                <Badge
                  variant="outline"
                  className="font-mono border-amber-500/50 text-amber-700 dark:text-amber-400"
                >
                  {staleCount} unused in {STALE_AFTER_DAYS}+ days
                </Badge>
              )}
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : grouped.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No aliases saved yet. They'll appear here as dispatchers
                confirm new customer files.
              </p>
            ) : (
              <div className="space-y-6">
                {grouped.map(([customer, rows]) => (
                  <div key={customer}>
                    <h2 className="font-display text-sm font-semibold mb-2 flex items-center gap-2">
                      {customer}
                      <span className="text-xs font-mono text-muted-foreground">
                        · {rows.length}
                      </span>
                    </h2>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name on doc</TableHead>
                          <TableHead>Mapped to</TableHead>
                          <TableHead>Last updated</TableHead>
                          <TableHead>Last used</TableHead>
                          <TableHead className="w-[1%]" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((a) => {
                          const isEditing =
                            edit?.customer === a.customer &&
                            edit?.nameOnDoc === a.nameOnDoc;
                          return (
                            <Fragment key={`${a.customer}::${a.nameOnDoc}`}>
                              <TableRow>
                                <TableCell className="font-mono text-xs align-top">
                                  {formatPersonName(a.nameOnDoc)}
                                </TableCell>
                                <TableCell className="text-xs align-top">
                                  {a.driverName ? (
                                    <div className="flex flex-col gap-0.5">
                                      <span className="font-medium">
                                        {formatPersonName(a.driverName)}
                                      </span>
                                      <span className="font-mono text-[10px] text-muted-foreground">
                                        {a.kfiId}
                                        {a.driverCustomer
                                          ? ` · ${a.driverCustomer}`
                                          : ""}
                                      </span>
                                      {a.driverIsArchived && (
                                        <span className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-mono flex items-center gap-1">
                                          <AlertTriangle className="h-3 w-3" />
                                          Archived driver
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="flex flex-col gap-0.5">
                                      <span className="font-mono text-[10px]">
                                        {a.kfiId}
                                      </span>
                                      <span className="text-[10px] uppercase tracking-wider text-rose-600 dark:text-rose-400 font-mono flex items-center gap-1">
                                        <AlertTriangle className="h-3 w-3" />
                                        Driver no longer in roster
                                      </span>
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs align-top whitespace-nowrap">
                                  <div className="font-mono text-muted-foreground">
                                    {format(
                                      new Date(a.updatedAt),
                                      "yyyy-MM-dd HH:mm",
                                    )}
                                  </div>
                                  {a.updatedByEmail && (
                                    <div className="font-mono text-[10px] text-muted-foreground">
                                      by {a.updatedByEmail}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs align-top whitespace-nowrap">
                                  {a.lastUsedWeek ? (
                                    <div className="flex flex-col gap-0.5">
                                      <span className="font-mono text-muted-foreground">
                                        week of {a.lastUsedWeek}
                                      </span>
                                      <span className="font-mono text-[10px] text-muted-foreground">
                                        {a.weeksUsedCount}{" "}
                                        {a.weeksUsedCount === 1
                                          ? "week"
                                          : "weeks"}{" "}
                                        applied
                                      </span>
                                      {isStale(a.lastUsedWeek) && (
                                        <span className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-mono">
                                          Stale
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="flex flex-col gap-0.5">
                                      <span className="font-mono text-[10px] text-muted-foreground italic">
                                        never seen in punches
                                      </span>
                                      <span className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-mono">
                                        Stale
                                      </span>
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell className="align-top">
                                  <div className="flex justify-end gap-1">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        setEdit(
                                          isEditing
                                            ? null
                                            : {
                                                customer: a.customer,
                                                nameOnDoc: a.nameOnDoc,
                                                kfiId: a.kfiId,
                                              },
                                        )
                                      }
                                    >
                                      <LinkIcon className="h-3 w-3 mr-1" />
                                      {isEditing ? "Cancel" : "Change driver"}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => handleForget(a)}
                                      disabled={forgetAlias.isPending}
                                      title="Delete this saved alias"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                              {isEditing && edit && (
                                <TableRow className="bg-muted/30 hover:bg-muted/30">
                                  <TableCell />
                                  <TableCell colSpan={4} className="py-3">
                                    <EditDriverRow
                                      drivers={drivers}
                                      currentKfiId={edit.kfiId}
                                      onChange={(kfiId) =>
                                        setEdit({ ...edit, kfiId })
                                      }
                                      onSave={handleSaveEdit}
                                      onCancel={() => setEdit(null)}
                                      pending={updateAlias.isPending}
                                      unchanged={edit.kfiId === a.kfiId}
                                    />
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <History className="h-4 w-4" />
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Append-only log of every alias re-map and forget. Use this to
              trace which admin (or dispatcher) changed a mapping when a
              dispatcher's punches start landing on the wrong driver.
            </p>
            {auditLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : auditLog && auditLog.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Customer · name on doc</TableHead>
                    <TableHead>Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLog.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap align-top">
                        {format(new Date(entry.createdAt), "yyyy-MM-dd HH:mm")}
                      </TableCell>
                      <TableCell className="font-mono text-xs align-top">
                        {entry.actorEmail ?? "—"}
                      </TableCell>
                      <TableCell className="align-top">
                        <span
                          className={`text-xs font-mono uppercase tracking-wider ${
                            entry.action === "forget"
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-primary"
                          }`}
                        >
                          {entry.action}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs align-top">
                        <div className="font-medium">{entry.customer}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {formatPersonName(entry.nameOnDoc)}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs align-top">
                        <div className="flex items-center gap-2 flex-wrap">
                          <KfiIdLabel
                            kfiId={entry.beforeKfiId ?? null}
                            driverName={entry.beforeDriverName ?? null}
                          />
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <KfiIdLabel
                            kfiId={entry.afterKfiId ?? null}
                            driverName={entry.afterDriverName ?? null}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                No alias changes recorded yet.
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function KfiIdLabel({
  kfiId,
  driverName,
}: {
  kfiId: string | null;
  driverName: string | null;
}) {
  if (!kfiId) {
    return (
      <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
        none
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col">
      <span className="font-medium">{driverName ? formatPersonName(driverName) : "Unknown driver"}</span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {kfiId}
      </span>
    </span>
  );
}

function EditDriverRow({
  drivers,
  currentKfiId,
  onChange,
  onSave,
  onCancel,
  pending,
  unchanged,
}: {
  drivers: DriverInfo[];
  currentKfiId: string;
  onChange: (kfiId: string) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
  unchanged: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[260px] space-y-1">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Re-map to driver
        </label>
        <Select value={currentKfiId} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Pick a driver" />
          </SelectTrigger>
          <SelectContent>
            {drivers.map((d) => (
              <SelectItem key={d.kfiId} value={d.kfiId}>
                <span className="font-medium">{formatPersonName(d.name)}</span>
                <span className="font-mono text-[10px] text-muted-foreground ml-2">
                  {d.kfiId} · {d.customer}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={pending || unchanged}
      >
        {pending && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
