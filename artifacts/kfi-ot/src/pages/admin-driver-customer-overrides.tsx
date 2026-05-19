import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListDriverCustomerOverrides,
  useClearDriverCustomerOverride,
  getListDriverCustomerOverridesQueryKey,
  getGetWeekSummaryQueryKey,
  type DriverCustomerOverride,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, Shuffle, X } from "lucide-react";
import { format } from "date-fns";
import { Logo } from "@/components/logo";

export default function AdminDriverCustomerOverrides() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data, isLoading } = useListDriverCustomerOverrides({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListDriverCustomerOverridesQueryKey(),
    },
  });

  const clear = useClearDriverCustomerOverride();

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const handleClear = (row: DriverCustomerOverride) => {
    clear.mutate(
      { params: { kfiId: row.kfiId } },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getListDriverCustomerOverridesQueryKey(),
          });
          qc.invalidateQueries({
            predicate: (q) => {
              const key = q.queryKey?.[0];
              return (
                typeof key === "string" &&
                key.startsWith("/api/weeks/") &&
                key.endsWith("/summary")
              );
            },
          });
          toast({
            title: `Cleared override for ${row.driverName ?? row.kfiId}`,
            description:
              "Driver is back under their Connecteam roster customer.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't clear override",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
          }),
      },
    );
  };

  const rows = data ?? [];

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
            Driver customer overrides
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Shuffle className="h-4 w-4" />
              Active overrides
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              A per-driver override re-groups that driver under a different
              customer on the week dashboard. Overrides survive Connecteam
              refreshes; the original roster customer is preserved on the
              driver record so this page can show it side-by-side. Use the
              "⋯" menu on any driver row in the sidebar to set or clear an
              override.
            </p>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : rows.length === 0 ? (
              <p
                className="text-sm text-muted-foreground italic"
                data-testid="overrides-empty"
              >
                No driver customer overrides. Open any week and use the row
                menu on a driver in the sidebar to move them.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Original (Connecteam)</TableHead>
                    <TableHead>Override</TableHead>
                    <TableHead>Set</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.kfiId}
                      data-testid={`row-override-${r.kfiId}`}
                    >
                      <TableCell className="text-sm font-medium">
                        {r.driverName ?? r.kfiId}
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {r.kfiId}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {r.originalCustomer ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {r.overrideCustomer}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {format(new Date(r.setAt), "yyyy-MM-dd HH:mm")}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {r.setByEmail ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleClear(r)}
                          disabled={clear.isPending}
                          data-testid={`clear-override-${r.kfiId}`}
                        >
                          {clear.isPending &&
                          clear.variables?.params.kfiId === r.kfiId ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <X className="h-3 w-3 mr-1" />
                          )}
                          Clear
                        </Button>
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
