import { useRef, useState } from "react";
import {
  useGetCustomerUploadStatus,
  getGetCustomerUploadStatusQueryKey,
  getGetWeekSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  UploadCloud,
  CheckCircle2,
  Circle,
  Sparkles,
  AlertCircle,
  Wand2,
} from "lucide-react";
import { NewCustomerDialog } from "@/components/new-customer-dialog";

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

interface RowState {
  uploading: boolean;
  error: string | null;
}

export function CustomerUploadPanel({ weekStart }: { weekStart: string }) {
  const { data: statuses } = useGetCustomerUploadStatus(weekStart);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [newOpen, setNewOpen] = useState(false);

  const setRow = (customer: string, patch: Partial<RowState>) => {
    setRowState((prev) => ({
      ...prev,
      [customer]: {
        ...{ uploading: false, error: null },
        ...prev[customer],
        ...patch,
      },
    }));
  };

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
    });
    queryClient.invalidateQueries({
      queryKey: getGetWeekSummaryQueryKey(weekStart),
    });
  };

  const uploadFor = async (customer: string, file: File) => {
    setRow(customer, { uploading: true, error: null });
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/weeks/${weekStart}/upload-customer-file`,
        { method: "POST", credentials: "include", body: formData },
      );
      const body = (await res.json().catch(() => null)) as
        | {
            customer?: string;
            punchesUpserted?: number;
            unmappedIds?: string[];
            error?: string;
          }
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? "Upload failed");
      }
      if (body?.customer && body.customer !== customer) {
        throw new Error(
          `File detected as "${body.customer}" but you uploaded it for "${customer}". Rename the file to include "${customer}" so it routes correctly.`,
        );
      }
      setRow(customer, { uploading: false, error: null });
      const unmapped = body?.unmappedIds ?? [];
      if (unmapped.length > 0) {
        toast({
          title: `${customer} uploaded with ${unmapped.length} unknown ${
            unmapped.length === 1 ? "badge" : "badges"
          }`,
          description: `Imported ${body?.punchesUpserted ?? 0} punches. These IDs aren't in the KFI roster, so their rows were skipped: ${unmapped.join(", ")}. Add them to the driver mapping if they're new hires.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: `${customer} uploaded`,
          description: `Imported ${body?.punchesUpserted ?? 0} punches.`,
        });
      }
      invalidateAll();
    } catch (err) {
      const msg = errMessage(err, "Upload failed");
      setRow(customer, { uploading: false, error: msg });
      toast({
        title: `${customer} upload failed`,
        description: msg,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="overflow-hidden border-border/60">
      <div className="bg-muted/40 px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <div>
          <h3 className="font-display font-semibold text-base">
            Customer files
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each customer's weekly export. Re-uploading replaces only that
            customer's imported rows; manual punches are kept.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setNewOpen(true)}
        >
          <Sparkles className="mr-2 h-4 w-4" />
          New customer file…
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {(statuses ?? []).map((s) => {
          const st = rowState[s.customer] ?? { uploading: false, error: null };
          const uploaded = s.punchCount > 0;
          const lastError = st.error ?? s.lastError ?? null;
          const showError = !!lastError && (st.error || !uploaded);
          const accept = s.extensions
            .map((e) => `.${e}`)
            .concat(s.extensions.includes("xlsx") ? [".xls"] : [])
            .join(",");
          return (
            <li
              key={s.customer}
              className="px-4 py-2.5 flex items-center gap-3 hover:bg-muted/20"
            >
              <div className="shrink-0">
                {showError ? (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                ) : uploaded ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/40" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{s.customer}</span>
                  {uploaded ? (
                    <Badge
                      variant="secondary"
                      className="font-mono text-[10px]"
                    >
                      {s.punchCount} punches
                    </Badge>
                  ) : showError ? (
                    <Badge
                      variant="destructive"
                      className="text-[10px]"
                    >
                      Last upload failed
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground"
                    >
                      Not uploaded
                    </Badge>
                  )}
                  {s.isAiImported && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400 gap-1"
                      title={
                        s.aiImportWeekCount >= 3
                          ? "This customer has been AI-imported multiple weeks in a row. Consider writing a deterministic parser — see docs/promote-ai-customer-to-parser.md."
                          : "AI-imported (no deterministic parser yet)."
                      }
                    >
                      <Wand2 className="h-3 w-3" />
                      AI · {s.aiImportWeekCount}{" "}
                      {s.aiImportWeekCount === 1 ? "week" : "weeks"}
                    </Badge>
                  )}
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {s.extensions.join(" / ")}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                  {s.lastUploadAt || s.lastAttemptAt ? (
                    <>
                      {new Date(
                        (s.lastUploadAt ?? s.lastAttemptAt) as string,
                      ).toLocaleString()}
                      {s.lastFileName ? ` · ${s.lastFileName}` : ""}
                    </>
                  ) : (
                    <span className="italic">No upload yet for this week</span>
                  )}
                </div>
                {showError && (
                  <div className="mt-1 text-xs text-destructive flex items-start gap-1">
                    <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>{lastError}</span>
                  </div>
                )}
              </div>
              <input
                type="file"
                ref={(el) => {
                  inputs.current[s.customer] = el;
                }}
                accept={accept}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadFor(s.customer, f);
                  e.target.value = "";
                }}
              />
              <Button
                variant={uploaded ? "outline" : "default"}
                size="sm"
                disabled={st.uploading}
                onClick={() => inputs.current[s.customer]?.click()}
              >
                {st.uploading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="mr-2 h-3.5 w-3.5" />
                )}
                {uploaded ? "Re-upload" : "Upload"}
              </Button>
            </li>
          );
        })}
      </ul>
      <NewCustomerDialog
        weekStart={weekStart}
        open={newOpen}
        onOpenChange={setNewOpen}
        onImported={invalidateAll}
      />
    </Card>
  );
}
