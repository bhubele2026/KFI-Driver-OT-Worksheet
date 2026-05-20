import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListBootAudit,
  getListBootAuditQueryKey,
  type BootAuditRow,
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
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";
import { format } from "date-fns";
import { Logo } from "@/components/logo";

const LIMIT = 50;

function outcomeBadge(o: BootAuditRow["outcome"]): {
  variant: "default" | "secondary" | "outline" | "destructive";
  label: string;
} {
  if (o === "ok") return { variant: "default", label: "ok" };
  if (o === "noop") return { variant: "outline", label: "no-op" };
  if (o === "refused") return { variant: "destructive", label: "refused" };
  return { variant: "destructive", label: "error" };
}

export default function AdminBootAudit() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data, isLoading } = useListBootAudit(
    { limit: LIMIT },
    {
      query: {
        enabled: !!me?.isAdmin,
        queryKey: getListBootAuditQueryKey({ limit: LIMIT }),
        refetchInterval: 30_000,
      },
    },
  );

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const rows: BootAuditRow[] = data ?? [];
  const lastClean = rows.find((r) => r.outcome === "noop");

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
          <h1 className="font-display font-bold text-lg tracking-tight">
            Boot-time audit
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-6xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Republish safety log
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4 max-w-3xl">
              Every routine that the API server runs at startup writes one row
              here — even when nothing changed (outcome <code>no-op</code>).
              That makes a republish auditable at a glance: if a clean boot has
              only <code>no-op</code> rows, none of the boot routines mutated
              dispatcher data. <code>refused</code> means the production
              bulk-delete guard tripped (it never deletes more than the
              configured threshold without an explicit{" "}
              <code>KFI_ALLOW_BULK_PUNCH_DELETE=1</code> opt-in).
            </p>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {rows.length} row{rows.length === 1 ? "" : "s"}
              </Badge>
              {lastClean && (
                <Badge variant="outline" className="font-mono">
                  Last clean boot row:{" "}
                  {format(new Date(lastClean.startedAt), "yyyy-MM-dd HH:mm")}
                </Badge>
              )}
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No boot-audit rows yet. The next API restart will write the
                first entries.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[160px]">When</TableHead>
                    <TableHead className="w-[220px]">Routine</TableHead>
                    <TableHead className="w-[100px]">Outcome</TableHead>
                    <TableHead className="w-[80px] text-right">Rows</TableHead>
                    <TableHead className="w-[160px]">Deploy / env</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const badge = outcomeBadge(r.outcome);
                    return (
                      <TableRow
                        key={r.id}
                        data-testid={`row-boot-audit-${r.id}`}
                      >
                        <TableCell className="text-xs align-top font-mono whitespace-nowrap text-muted-foreground">
                          {format(
                            new Date(r.startedAt),
                            "yyyy-MM-dd HH:mm:ss",
                          )}
                        </TableCell>
                        <TableCell className="text-xs align-top font-mono">
                          {r.routine}
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge
                            variant={badge.variant}
                            className="font-mono text-[10px]"
                          >
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs align-top text-right font-mono">
                          {r.rowsAffected}
                        </TableCell>
                        <TableCell className="text-[10px] align-top font-mono text-muted-foreground">
                          {r.deploymentId ? (
                            <div>{r.deploymentId.slice(0, 12)}</div>
                          ) : (
                            <div className="italic">no deploy id</div>
                          )}
                          {r.nodeEnv && <div>{r.nodeEnv}</div>}
                          {r.gitSha && <div>{r.gitSha.slice(0, 8)}</div>}
                        </TableCell>
                        <TableCell className="text-xs align-top">
                          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground max-w-[60ch]">
                            {r.detail ?? ""}
                          </pre>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
