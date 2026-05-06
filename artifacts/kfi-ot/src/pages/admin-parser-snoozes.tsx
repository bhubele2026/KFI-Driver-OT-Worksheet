import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListParserPromotionSnoozes,
  useRemoveParserPromotionSnooze,
  getListParserPromotionSnoozesQueryKey,
  type ParserPromotionSnooze,
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
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, BellOff, BellRing, Loader2 } from "lucide-react";
import { format } from "date-fns";

function snoozeStatus(s: ParserPromotionSnooze): {
  label: string;
  expired: boolean;
} {
  if (!s.snoozedUntil) return { label: "Forever (until lifted)", expired: false };
  const until = new Date(s.snoozedUntil);
  if (until.getTime() <= Date.now()) {
    return {
      label: `Expired ${format(until, "yyyy-MM-dd HH:mm")}`,
      expired: true,
    };
  }
  return {
    label: `Until ${format(until, "yyyy-MM-dd HH:mm")}`,
    expired: false,
  };
}

export default function AdminParserSnoozes() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data, isLoading } = useListParserPromotionSnoozes({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListParserPromotionSnoozesQueryKey(),
    },
  });

  const removeSnooze = useRemoveParserPromotionSnooze();

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const handleResume = (s: ParserPromotionSnooze) => {
    removeSnooze.mutate(
      { params: { customer: s.customer } },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getListParserPromotionSnoozesQueryKey(),
          });
          // The customer-uploads response is per-week and we don't know which
          // week the dispatcher is currently viewing — invalidate every cached
          // copy (key shape: [`/api/weeks/${weekStart}/customer-uploads`]) so
          // the suggestion re-appears immediately.
          qc.invalidateQueries({
            predicate: (q) => {
              const key = q.queryKey?.[0];
              return (
                typeof key === "string" &&
                key.startsWith("/api/weeks/") &&
                key.endsWith("/customer-uploads")
              );
            },
          });
          toast({
            title: "Snooze lifted",
            description: `"${s.customer}" can be suggested again.`,
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't lift snooze",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const snoozes = data ?? [];
  const active = snoozes.filter((s) => !snoozeStatus(s).expired);
  const expired = snoozes.filter((s) => snoozeStatus(s).expired);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
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
            Admin · Parser-promotion snoozes
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <BellOff className="h-4 w-4" />
              Snoozed customers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              The week dashboard hides the "Parser candidate" suggestion for
              every customer listed below. Lift a snooze to let the suggestion
              come back the next time the customer crosses the heuristic
              threshold (3+ AI-imported weeks or 5+ saved aliases).
            </p>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {active.length} active
              </Badge>
              {expired.length > 0 && (
                <Badge variant="outline" className="font-mono">
                  {expired.length} expired
                </Badge>
              )}
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : snoozes.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No snoozes yet. Use the "Don't suggest" button on the week
                dashboard's parser-candidate banner to add one.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Snoozed</TableHead>
                    <TableHead>Until</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snoozes.map((s) => {
                    const status = snoozeStatus(s);
                    return (
                      <TableRow key={s.customer}>
                        <TableCell className="text-sm align-top">
                          <div className="font-medium">{s.customer}</div>
                          {s.reason && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {s.reason}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs align-top whitespace-nowrap font-mono text-muted-foreground">
                          {format(
                            new Date(s.snoozedAt),
                            "yyyy-MM-dd HH:mm",
                          )}
                        </TableCell>
                        <TableCell className="text-xs align-top whitespace-nowrap">
                          {status.expired ? (
                            <Badge
                              variant="outline"
                              className="font-mono text-[10px] border-muted-foreground/40 text-muted-foreground"
                            >
                              {status.label}
                            </Badge>
                          ) : (
                            <span className="font-mono text-muted-foreground">
                              {status.label}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs align-top font-mono text-muted-foreground">
                          {s.snoozedByEmail ?? "—"}
                        </TableCell>
                        <TableCell className="align-top">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleResume(s)}
                            disabled={removeSnooze.isPending}
                          >
                            {removeSnooze.isPending &&
                            removeSnooze.variables?.params.customer ===
                              s.customer ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <BellRing className="h-3 w-3 mr-1" />
                            )}
                            Resume suggestions
                          </Button>
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
