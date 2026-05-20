import { useTranslation } from "react-i18next";
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
import { Logo } from "@/components/logo";

function snoozeStatus(
  s: ParserPromotionSnooze,
  t: (key: string, opts?: Record<string, unknown>) => string,
): {
  label: string;
  expired: boolean;
} {
  if (!s.snoozedUntil) return { label: t("adminSnoozesExtra.foreverLabel"), expired: false };
  const until = new Date(s.snoozedUntil);
  if (until.getTime() <= Date.now()) {
    return {
      label: t("adminSnoozesExtra.expiredLabel", { when: format(until, "yyyy-MM-dd HH:mm") }),
      expired: true,
    };
  }
  return {
    label: t("adminSnoozesExtra.untilLabel", { when: format(until, "yyyy-MM-dd HH:mm") }),
    expired: false,
  };
}

export default function AdminParserSnoozes() {
  const { t } = useTranslation();
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
            title: t("adminSnoozesExtra.snoozeLifted"),
            description: t("adminSnoozesExtra.snoozeLiftedDesc", { customer: s.customer }),
          });
        },
        onError: (err) =>
          toast({
            title: t("adminSnoozesExtra.liftFailed"),
            description: err instanceof Error ? err.message : t("errors.unknown"),
            variant: "destructive",
          }),
      },
    );
  };

  const snoozes = data ?? [];
  const active = snoozes.filter((s) => !snoozeStatus(s, t).expired);
  const expired = snoozes.filter((s) => snoozeStatus(s, t).expired);

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
            {t("adminSnoozes.title")}
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 max-w-5xl w-full mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <BellOff className="h-4 w-4" />
              {t("adminSnoozesExtra.cardTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              {t("adminSnoozesExtra.description")}
            </p>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              <Badge variant="secondary" className="font-mono">
                {t("adminSnoozesExtra.activeCount", { count: active.length })}
              </Badge>
              {expired.length > 0 && (
                <Badge variant="outline" className="font-mono">
                  {t("adminSnoozesExtra.expiredCount", { count: expired.length })}
                </Badge>
              )}
            </div>

            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : snoozes.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                {t("adminSnoozesExtra.empty")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adminSnoozesExtra.headerCustomer")}</TableHead>
                    <TableHead>{t("adminSnoozesExtra.headerSnoozed")}</TableHead>
                    <TableHead>{t("adminSnoozesExtra.headerUntil")}</TableHead>
                    <TableHead>{t("adminSnoozesExtra.headerBy")}</TableHead>
                    <TableHead className="w-[1%]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snoozes.map((s) => {
                    const status = snoozeStatus(s, t);
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
                            {t("adminSnoozesExtra.resumeButton")}
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
