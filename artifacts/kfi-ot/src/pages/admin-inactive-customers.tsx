import { useTranslation } from "react-i18next";
import { Link, Redirect } from "wouter";
import {
  useGetMe,
  useListInactiveCustomers,
  useReactivateCustomer,
  getListInactiveCustomersQueryKey,
  type InactiveCustomer,
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
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, EyeOff, Eye, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { Logo } from "@/components/logo";

export default function AdminInactiveCustomers() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();

  const { data, isLoading } = useListInactiveCustomers({
    query: {
      enabled: !!me?.isAdmin,
      queryKey: getListInactiveCustomersQueryKey(),
    },
  });

  const reactivate = useReactivateCustomer();

  if (!meLoading && me && !me.isAdmin) {
    return <Redirect to="/" />;
  }

  const handleReactivate = (c: InactiveCustomer) => {
    reactivate.mutate(
      { params: { customer: c.customer } },
      {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: getListInactiveCustomersQueryKey(),
          });
          // Customer-uploads is per-week; invalidate every cached copy so the
          // row reappears immediately whichever week the dispatcher is viewing.
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
            title: t("adminInactive.reactivatedTitle", { customer: c.customer }),
            description: t("adminInactive.reactivatedDesc"),
          });
        },
        onError: (err) =>
          toast({
            title: t("adminInactive.reactivateFailed"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
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
            {t("adminInactive.title")}
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <EyeOff className="h-4 w-4" />
              {t("adminInactive.cardTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              {t("adminInactive.description")}
            </p>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                {t("adminInactive.empty")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminInactive.headerCustomer")}</TableHead>
                    <TableHead>{t("adminInactive.headerMarked")}</TableHead>
                    <TableHead>{t("adminInactive.headerBy")}</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow key={c.customer}>
                      <TableCell className="text-sm font-medium">
                        {c.customer}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {format(new Date(c.inactiveAt), "yyyy-MM-dd HH:mm")}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {c.inactiveByEmail ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleReactivate(c)}
                          disabled={reactivate.isPending}
                          data-testid={`reactivate-${c.customer}`}
                        >
                          {reactivate.isPending &&
                          reactivate.variables?.params.customer ===
                            c.customer ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Eye className="h-3 w-3 mr-1" />
                          )}
                          {t("adminInactive.reactivateButton")}
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
