import { useMemo } from "react";
import { Link, Redirect, useSearch, useLocation } from "wouter";
import {
  useGetMe,
  useListAiExtractSamples,
  getListAiExtractSamplesQueryKey,
  getDownloadAiExtractSampleUrl,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  Loader2,
  Sparkles,
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
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
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
              after 24 hours; confirmed samples are kept for 90 days.
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
                          <TableHead className="w-[110px]">Status</TableHead>
                          <TableHead className="w-[110px] text-right">
                            Action
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((s) => {
                          const downloadUrl = `${import.meta.env.BASE_URL}${getDownloadAiExtractSampleUrl(
                            s.id,
                          ).replace(/^\//, "")}`;
                          return (
                            <TableRow key={s.id}>
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
                              </TableCell>
                              <TableCell className="text-right">
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
      </main>
    </div>
  );
}
