import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  useGetCustomerUploadStatus,
  useGetMe,
  useCreateParserPromotionSnooze,
  getGetCustomerUploadStatusQueryKey,
  getGetWeekSummaryQueryKey,
  getListParserPromotionSnoozesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  UploadCloud,
  CheckCircle2,
  Circle,
  Sparkles,
  AlertCircle,
  Wand2,
  Lightbulb,
  BellOff,
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
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [newOpen, setNewOpen] = useState(false);
  const snoozeMutation = useCreateParserPromotionSnooze();

  const snooze = (customer: string, snoozeWeeks: number | null) => {
    snoozeMutation.mutate(
      { data: { customer, snoozeWeeks } },
      {
        onSuccess: () => {
          toast({
            title: `Snoozed "${customer}"`,
            description:
              snoozeWeeks == null
                ? "The promotion suggestion is hidden until you lift the snooze in Admin."
                : `The promotion suggestion is hidden for ${snoozeWeeks} ${snoozeWeeks === 1 ? "week" : "weeks"}.`,
          });
          queryClient.invalidateQueries({
            queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
          });
          queryClient.invalidateQueries({
            queryKey: getListParserPromotionSnoozesQueryKey(),
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't snooze suggestion",
            description: errMessage(err, "Snooze failed"),
            variant: "destructive",
          }),
      },
    );
  };

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
            unmappedIds?: Array<{
              id: string;
              count: number;
              sampleName: string | null;
            }>;
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
        const formatted = unmapped
          .map((u) => (u.sampleName ? `${u.id} (${u.sampleName})` : u.id))
          .join(", ");
        toast({
          title: `${customer} uploaded with ${unmapped.length} unknown ${
            unmapped.length === 1 ? "badge" : "badges"
          }`,
          description: `Imported ${body?.punchesUpserted ?? 0} punches. These IDs aren't in the KFI roster, so their rows were skipped: ${formatted}. Add them to the driver mapping if they're new hires.`,
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

  const promotionCandidates = (statuses ?? []).filter(
    (s) => s.promotionCandidate,
  );

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
      {promotionCandidates.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 space-y-2">
          <div className="flex items-start gap-2">
            <Lightbulb className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <div className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
              <span className="font-semibold">
                {promotionCandidates.length === 1
                  ? "Parser candidate:"
                  : "Parser candidates:"}
              </span>{" "}
              These customers have come through the AI flow enough to justify a
              real parser. See{" "}
              <code className="font-mono text-[11px] px-1 py-0.5 rounded bg-amber-500/10">
                docs/promote-ai-customer-to-parser.md
              </code>{" "}
              for the promotion checklist.
              {me?.isAdmin && (
                <>
                  {" "}
                  Manage hidden suggestions on{" "}
                  <Link
                    href="/admin/parser-snoozes"
                    className="underline underline-offset-2"
                  >
                    Admin · Parser snoozes
                  </Link>
                  .
                </>
              )}
            </div>
          </div>
          <ul className="ml-6 space-y-1">
            {promotionCandidates.map((s) => (
              <li
                key={s.customer}
                className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200"
              >
                <span className="font-medium">{s.customer}</span>
                <span className="font-mono text-[10px] text-amber-800/80 dark:text-amber-300/80">
                  {s.aiImportWeekCount}{" "}
                  {s.aiImportWeekCount === 1 ? "week" : "weeks"} AI ·{" "}
                  {s.aliasCount}{" "}
                  {s.aliasCount === 1 ? "alias" : "aliases"}
                </span>
                {me?.isAdmin && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-amber-900 dark:text-amber-200 hover:bg-amber-500/10"
                        disabled={snoozeMutation.isPending}
                      >
                        {snoozeMutation.isPending &&
                        snoozeMutation.variables?.data.customer ===
                          s.customer ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <BellOff className="h-3 w-3 mr-1" />
                        )}
                        Don't suggest
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel className="text-xs">
                        Snooze "{s.customer}" for…
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => snooze(s.customer, 4)}>
                        4 weeks
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => snooze(s.customer, 12)}>
                        12 weeks
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => snooze(s.customer, 26)}>
                        26 weeks
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => snooze(s.customer, null)}
                      >
                        Forever (until lifted)
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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
                  {s.isAiImported &&
                    (me?.isAdmin ? (
                      <Link
                        href={`/admin/ai-samples?customer=${encodeURIComponent(s.customer)}`}
                      >
                        <Badge
                          variant="outline"
                          className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400 gap-1 cursor-pointer hover:bg-amber-500/10"
                          title={
                            s.promotionCandidate
                              ? `This customer has accumulated ${s.aiImportWeekCount} AI-imported week(s) and ${s.aliasCount} saved driver alias(es). Click to view stashed samples — and consider writing a deterministic parser.`
                              : `AI-imported (no deterministic parser yet). ${s.aliasCount} saved driver alias(es). Click to view stashed samples.`
                          }
                        >
                          <Wand2 className="h-3 w-3" />
                          AI · {s.aiImportWeekCount}{" "}
                          {s.aiImportWeekCount === 1 ? "week" : "weeks"}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400 gap-1"
                        title={
                          s.promotionCandidate
                            ? `This customer has accumulated ${s.aiImportWeekCount} AI-imported week(s) and ${s.aliasCount} saved driver alias(es). Consider writing a deterministic parser — see docs/promote-ai-customer-to-parser.md.`
                            : `AI-imported (no deterministic parser yet). ${s.aliasCount} saved driver alias(es).`
                        }
                      >
                        <Wand2 className="h-3 w-3" />
                        AI · {s.aiImportWeekCount}{" "}
                        {s.aiImportWeekCount === 1 ? "week" : "weeks"}
                      </Badge>
                    ))}
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
                {!showError && s.lastUnmappedIds.length > 0 && (
                  <div className="mt-1 text-xs text-destructive flex items-start gap-1">
                    <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>
                      Unknown {s.lastUnmappedIds.length === 1 ? "badge" : "badges"}:{" "}
                      {s.lastUnmappedIds.map((u, i) => {
                        const params = new URLSearchParams({
                          id: u.id,
                          customer: s.customer,
                        });
                        if (u.sampleName) params.set("sampleName", u.sampleName);
                        const label = u.sampleName
                          ? `${u.id} (${u.sampleName})`
                          : u.id;
                        return (
                          <span key={u.id}>
                            {i > 0 && ", "}
                            {me?.isAdmin ? (
                              <Link
                                href={`/admin/driver-id-aliases?${params.toString()}`}
                                className="font-mono underline decoration-dotted hover:text-destructive/80"
                              >
                                {label}
                              </Link>
                            ) : (
                              <span className="font-mono">{label}</span>
                            )}
                          </span>
                        );
                      })}
                      .{" "}
                      {me?.isAdmin
                        ? "Click an id to add a driver mapping."
                        : "Ask an admin to add the missing driver mapping."}
                    </span>
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
