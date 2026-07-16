import { useParams, useLocation } from "wouter";
import { format, startOfWeek } from "date-fns";
import {
  useRefreshConnecteam,
  getGetWeekSummaryQueryKey,
  getGetCustomerUploadStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/app-shell";
import { WeekToolbar } from "@/components/week-toolbar";
import { CustomerUploadPanel } from "@/components/customer-upload-panel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export default function DriverUpload() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const refreshCt = useRefreshConnecteam();

  const defaultWeek = format(startOfWeek(new Date(), { weekStartsOn: 0 }), "yyyy-MM-dd");
  const weekStart = (params.weekStart as string) || defaultWeek;

  const handleRefresh = () =>
    refreshCt.mutate(
      { weekStart },
      {
        onSuccess: (data) => {
          qc.invalidateQueries({ queryKey: getGetWeekSummaryQueryKey(weekStart) });
          qc.invalidateQueries({ queryKey: getGetCustomerUploadStatusQueryKey(weekStart) });
          toast({
            title: t("weekSummary.refreshSuccessTitle"),
            description: t("weekSummary.refreshSuccessDesc", {
              drivers: data.driversFound,
              punches: data.punchesUpserted,
            }),
          });
        },
        onError: () =>
          toast({ title: t("weekSummary.refreshFailedTitle"), variant: "destructive" }),
      },
    );

  return (
    <AppShell active="/upload">
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Driver Upload</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pull the week's punches from Connecteam, then drop in each customer's timesheet.
          </p>
        </div>
        <WeekToolbar
          weekStart={weekStart}
          onChange={(w) => setLocation(`/upload/${w}`)}
          actions={
            <Button onClick={handleRefresh} disabled={refreshCt.isPending}>
              <RefreshCw className={cn("h-4 w-4", refreshCt.isPending && "animate-spin")} />
              Refresh Connecteam
            </Button>
          }
        />
        <CustomerUploadPanel weekStart={weekStart} />
      </div>
    </AppShell>
  );
}
