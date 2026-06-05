import { useState } from "react";
import {
  useGetUploadAnalysisVerdict,
  getGetUploadAnalysisVerdictQueryKey,
  type UploadAnalysisSummary,
  type UploadAnalysisFinding,
  type UploadAnalysisFindingKind,
  type UploadAnalysisFindingSeverity,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldAlert,
  Loader2,
} from "lucide-react";

interface PillProps {
  weekStart: string;
  customer: string;
  summary: UploadAnalysisSummary;
}

const KIND_LABEL: Record<UploadAnalysisFindingKind, string> = {
  extraction_completeness: "Extraction completeness",
  roster_match_quality: "Roster match quality",
  hours_anomaly: "Hours anomaly",
  missing_or_new_driver: "Missing or new driver",
  structural_concern: "Structural concern",
};

function verdictStyle(v: string): {
  label: string;
  className: string;
  icon: typeof CheckCircle2;
} {
  switch (v) {
    case "ok":
      return {
        label: "Review: clean",
        className:
          "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10",
        icon: CheckCircle2,
      };
    case "warn":
      return {
        label: "Review: warn",
        className:
          "border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10",
        icon: AlertTriangle,
      };
    case "fail":
      return {
        label: "Review: fail",
        className:
          "border-destructive/50 text-destructive hover:bg-destructive/10",
        icon: ShieldAlert,
      };
    default:
      return {
        label: "Review: error",
        className:
          "border-muted-foreground/40 text-muted-foreground hover:bg-muted/40",
        icon: Info,
      };
  }
}

function severityIcon(sev: UploadAnalysisFindingSeverity) {
  if (sev === "fail") return <ShieldAlert className="h-3.5 w-3.5 text-destructive" />;
  if (sev === "warn")
    return (
      <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
    );
  return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
}

export function UploadAnalysisPill({ weekStart, customer, summary }: PillProps) {
  const [open, setOpen] = useState(false);
  const style = verdictStyle(summary.verdict);
  const Icon = style.icon;
  const detail = useGetUploadAnalysisVerdict(weekStart, summary.sampleId, {
    query: {
      queryKey: getGetUploadAnalysisVerdictQueryKey(
        weekStart,
        summary.sampleId,
      ),
      enabled: open,
      staleTime: 60_000,
    },
  });
  const findings: UploadAnalysisFinding[] = detail.data?.findings ?? [];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`upload-analysis-pill-${customer}`}
        className="inline-flex"
        title={summary.summary}
      >
        <Badge
          variant="outline"
          className={`text-[10px] gap-1 cursor-pointer ${style.className}`}
        >
          <Icon className="h-3 w-3" />
          {style.label}
          {summary.findingCount > 0 ? ` · ${summary.findingCount}` : ""}
        </Badge>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-2xl"
          data-testid={`upload-analysis-dialog-${customer}`}
        >
          <DialogHeader>
            <DialogTitle>
              Upload review — {customer}
            </DialogTitle>
            <DialogDescription>
              {summary.summary || "No summary provided."}
            </DialogDescription>
          </DialogHeader>
          <div className="text-xs text-muted-foreground font-mono">
            verdict: {summary.verdict} · lane: {summary.lane} · prompt:{" "}
            {summary.promptVersion} ·{" "}
            {new Date(summary.createdAt).toLocaleString()}
          </div>
          {summary.errMsg && (
            <div className="text-sm text-destructive border border-destructive/30 rounded p-2">
              Reviewer error: {summary.errMsg}
            </div>
          )}
          {detail.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading findings…
            </div>
          )}
          {detail.isError && (
            <div className="text-sm text-destructive">
              Could not load findings.
            </div>
          )}
          {!detail.isLoading && !detail.isError && (
            <ul className="space-y-2 max-h-[50vh] overflow-y-auto">
              {findings.length === 0 ? (
                <li className="text-sm text-muted-foreground italic">
                  No findings recorded.
                </li>
              ) : (
                findings.map((f, i) => (
                  <li
                    key={i}
                    className="border rounded p-2 text-sm"
                    data-testid={`upload-analysis-finding-${i}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {severityIcon(f.severity)}
                      <span className="font-semibold text-xs uppercase tracking-wider">
                        {KIND_LABEL[f.kind] ?? f.kind}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {f.severity}
                      </Badge>
                    </div>
                    <div className="mt-1">{f.message}</div>
                    {f.evidence && (
                      <div className="mt-1 text-xs text-muted-foreground font-mono">
                        {f.evidence.driver && <>driver: {f.evidence.driver} · </>}
                        {f.evidence.kfiId && <>kfiId: {f.evidence.kfiId} · </>}
                        {f.evidence.date && <>date: {f.evidence.date} · </>}
                        {f.evidence.rowIds && f.evidence.rowIds.length > 0 && (
                          <>rows: {f.evidence.rowIds.join(", ")} · </>
                        )}
                        {f.evidence.note && <>note: {f.evidence.note}</>}
                      </div>
                    )}
                  </li>
                ))
              )}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
