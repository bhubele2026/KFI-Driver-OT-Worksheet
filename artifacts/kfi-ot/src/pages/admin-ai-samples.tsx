import { useMemo } from "react";
import { Link, Redirect, useSearch, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useListAiExtractSamples,
  useDeleteAiExtractSample,
  useListUserAuditLog,
  usePinAiExtractSample,
  getListAiExtractSamplesQueryKey,
  getListUserAuditLogQueryKey,
  getDownloadAiExtractSampleUrl,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/logo";
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
import {
  ArrowLeft,
  Download,
  History,
  Loader2,
  Pin,
  PinOff,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function AdminAiSamples() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const deleteSample = useDeleteAiExtractSample({
    mutation: {
      onSuccess: () => {
        toast({ title: "Sample deleted" });
        qc.invalidateQueries({ queryKey: getListAiExtractSamplesQueryKey() });
        qc.invalidateQueries({
          queryKey: getListUserAuditLogQueryKey({ limit: 200 }),
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not delete sample",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });
  const pinSample = usePinAiExtractSample({
    mutation: {
      onSuccess: (updated) => {
        toast({
          title: updated.pinned ? "Sample pinned" : "Sample unpinned",
          description: updated.pinned
            ? "This sample is exempt from the TTL cleanup."
            : "This sample will expire on its normal schedule.",
        });
        qc.invalidateQueries({ queryKey: getListAiExtractSamplesQueryKey() });
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not update pin",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const customerFilter = useMemo(() => {
    const params = new URLSearchParams(search);
    return params.get("customer") ?? "";
  }, [search]);

  const { data: samples, isLoading } = useListAiExtractSamples(undefined, {
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListAiExtractSamplesQueryKey(),
    },
  });

  const { data: auditLog, isLoading: auditLoading } = useListUserAuditLog(
    { limit: 200 },
    {
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListUserAuditLogQueryKey({ limit: 200 }),
      },
    },
  );

  const recentDeletions = useMemo(() => {
    if (!auditLog) return [];
    return auditLog
      .filter(
        (e) =>
          e.action === "delete-ai-extract-sample" &&
          e.aiSample &&
          (!customerFilter || e.aiSample.customer === customerFilter),
      )
      .slice(0, 25);
  }, [auditLog, customerFilter]);

  const allRows = samples ?? [];
  const customers = useMemo(() => {
    const set = new Set<string>();
    for (const s of allRows) set.add(s.customer);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allRows]);

  const filtered = customerFilter
    ? allRows.filter((s) => s.customer === customerFilter)
    : allRows;

  const grouped = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    for (const s of filtered) {
      const list = m.get(s.customer) ?? [];
      list.push(s);
      m.set(s.customer, list);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const setCustomer = (next: string) => {
    if (!next || next === "__all__") {
      setLocation("/admin/ai-samples");
    } else {
      setLocation(`/admin/ai-samples?customer=${encodeURIComponent(next)}`);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 h-14 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <Link href="/" title="KFI Staffing" className="no-underline"><Logo /></Link>
          <div className="h-5 w-px bg-sidebar-border/60" />
          <Link href="/">
            <Button
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <h1 className="font-display font-bold text-lg tracking-tight">
            Admin · AI samples
          </h1>
        </div>
        <Link href="/admin/users">
          <Button
            variant="ghost"
            size="sm"
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8"
          >
            <Users className="h-4 w-4 mr-2" />
            Users
          </Button>
        </Link>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Stashed AI customer files
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Original files uploaded through the "New customer file…" flow are
              stashed here so engineers can grab a fixture when promoting a
              customer to a deterministic parser. Unconfirmed samples expire
              after 24 hours; confirmed samples are kept for 90 days. Pin a
              sample to keep it indefinitely.
              See{" "}
              <code className="font-mono">
                docs/promote-ai-customer-to-parser.md
              </code>{" "}
              for the full workflow.
            </p>

            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Filter
              </span>
              <Select
                value={customerFilter || "__all__"}
                onValueChange={setCustomer}
              >
                <SelectTrigger className="w-[260px] h-8 text-sm">
                  <SelectValue placeholder="All customers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All customers</SelectItem>
                  {customers.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {customerFilter && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCustomer("")}
                >
                  Clear
                </Button>
              )}
            </div>

            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading samples…
              </div>
            ) : grouped.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                {customerFilter
                  ? `No stashed samples for "${customerFilter}".`
                  : "No stashed AI samples. They appear here after a dispatcher uses the \"New customer file…\" flow."}
              </p>
            ) : (
              <div className="space-y-6">
                {grouped.map(([customer, rows]) => (
                  <div key={customer} className="space-y-2">
                    <div className="flex items-baseline gap-2">
                      <h3 className="font-display font-semibold text-sm">
                        {customer}
                      </h3>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        {rows.length}{" "}
                        {rows.length === 1 ? "sample" : "samples"}
                      </span>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[110px]">Week</TableHead>
                          <TableHead>File</TableHead>
                          <TableHead className="w-[90px]">Size</TableHead>
                          <TableHead className="w-[180px]">Uploaded</TableHead>
                          <TableHead className="w-[180px]">By</TableHead>
                          <TableHead className="w-[160px]">Status</TableHead>
                          <TableHead className="w-[280px] text-right">
                            Actions
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((s) => {
                          const downloadUrl = `${import.meta.env.BASE_URL}${getDownloadAiExtractSampleUrl(
                            s.id,
                          ).replace(/^\//, "")}`;
                          const pinPending =
                            pinSample.isPending &&
                            pinSample.variables?.id === s.id;
                          return (
                            <TableRow
                              key={s.id}
                              className={
                                s.pinned
                                  ? "bg-amber-50/60 dark:bg-amber-950/20"
                                  : undefined
                              }
                            >
                              <TableCell className="font-mono text-xs">
                                {s.weekStart}
                              </TableCell>
                              <TableCell className="text-sm font-mono break-all">
                                {s.fileName}
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {formatBytes(s.sizeBytes)}
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {new Date(s.uploadedAt).toLocaleString()}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground break-all">
                                {s.uploadedByEmail ?? (
                                  <span className="italic">unknown</span>
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {s.confirmed ? (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                                      title={`Expires ${new Date(s.expiresAt).toLocaleString()}`}
                                    >
                                      Confirmed
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400"
                                      title={`Expires ${new Date(s.expiresAt).toLocaleString()}`}
                                    >
                                      Unconfirmed
                                    </Badge>
                                  )}
                                  {s.pinned && (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] border-amber-600/50 bg-amber-100/60 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                                      title="Pinned: exempt from TTL cleanup"
                                    >
                                      <Pin className="h-2.5 w-2.5 mr-1" />
                                      Pinned
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    type="button"
                                    disabled={pinPending}
                                    onClick={() =>
                                      pinSample.mutate({
                                        id: s.id,
                                        data: { pinned: !s.pinned },
                                      })
                                    }
                                    title={
                                      s.pinned
                                        ? "Unpin: allow this sample to expire on its normal schedule"
                                        : "Pin: keep this sample even after the TTL"
                                    }
                                  >
                                    {pinPending ? (
                                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                    ) : s.pinned ? (
                                      <PinOff className="h-3.5 w-3.5 mr-1.5" />
                                    ) : (
                                      <Pin className="h-3.5 w-3.5 mr-1.5" />
                                    )}
                                    {s.pinned ? "Unpin" : "Pin"}
                                  </Button>
                                  <a
                                    href={downloadUrl}
                                    download={s.fileName}
                                  >
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      type="button"
                                    >
                                      <Download className="h-3.5 w-3.5 mr-1.5" />
                                      Download
                                    </Button>
                                  </a>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    type="button"
                                    className="text-destructive hover:text-destructive"
                                    disabled={
                                      deleteSample.isPending &&
                                      deleteSample.variables?.id === s.id
                                    }
                                    onClick={() => {
                                      if (
                                        !confirm(
                                          `Delete this stashed AI sample?\n\n${s.fileName}\n(${s.customer}, week ${s.weekStart})\n\nThis cannot be undone.`,
                                        )
                                      )
                                        return;
                                      deleteSample.mutate({ id: s.id });
                                    }}
                                  >
                                    {deleteSample.isPending &&
                                    deleteSample.variables?.id === s.id ? (
                                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                    ) : (
                                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                    )}
                                    Delete
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
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
              Recent AI sample deletions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Append-only log of admin deletes from this page.
              {customerFilter ? ` Filtered to ${customerFilter}.` : ""}
            </p>
            {auditLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading history…
              </div>
            ) : recentDeletions.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No AI sample deletions recorded
                {customerFilter ? ` for "${customerFilter}"` : ""} yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[160px]">When</TableHead>
                    <TableHead className="w-[200px]">Deleted by</TableHead>
                    <TableHead className="w-[110px]">Week</TableHead>
                    <TableHead className="w-[160px]">Customer</TableHead>
                    <TableHead>File</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentDeletions.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(entry.createdAt), "yyyy-MM-dd HH:mm")}
                      </TableCell>
                      <TableCell className="font-mono text-xs break-all">
                        {entry.actorEmail ?? (
                          <span className="italic">unknown</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {entry.aiSample?.weekStart || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {entry.aiSample?.customer}
                      </TableCell>
                      <TableCell className="font-mono text-xs break-all">
                        {entry.aiSample?.fileName}
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
