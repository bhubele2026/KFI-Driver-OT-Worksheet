import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useConfirmCustomerFile,
  useDiscardCustomerExtract,
  useListDriverIdAliases,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DriverPicker } from "@/components/driver-picker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatPersonName } from "@/lib/format-name";
import { AlertCircle, Loader2, MessageSquare, UploadCloud } from "lucide-react";

const SKIP_PICK = "__skip__";
const IGNORE_PICK = "__ignore__";

export interface CustomerPreviewRow {
  index: number;
  sourceRow: string;
  kfiId: string;
  driverName: string | null;
  date: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  payType: string | null;
}

export interface CustomerPreviewSuggestion {
  kfiId: string;
  name: string;
  confidence: number;
}

export interface CustomerPreviewUnmappedId {
  id: string;
  count: number;
  sampleName: string | null;
  suggestions?: CustomerPreviewSuggestion[];
}

export interface CustomerPreviewData {
  customer: string;
  fileName: string;
  weekStart: string;
  sampleId: number;
  rows: CustomerPreviewRow[];
  unmappedIds: CustomerPreviewUnmappedId[];
  autoIgnoredIds?: CustomerPreviewUnmappedId[];
  existingPunchCount: number;
  extractSource?: "cache" | "ai";
  cacheWritten?: boolean;
  /**
   * Task #264. True when at least one Gemini response was truncated at
   * the output-token cap and salvage recovered only the rows that fit
   * (even after auto-chunking + halving retries). The dispatcher needs
   * to know rows are likely missing before confirming.
   */
  extractionTruncated?: boolean;
  failedChunks?: number;
  /**
   * Task #297. True when this extract fell back to Gemini (Claude
   * unreachable + per-customer `allowGeminiFallback` was on). Amber
   * banner gives the dispatcher a heads-up that the rows came from a
   * different model than the usual Claude pipeline.
   */
  geminiFallbackUsed?: boolean;
  /**
   * Task #358. True on the per-row Re-upload path when the uploaded
   * file's SHA-256 matches the most recent successful import for this
   * (week, customer). The dialog shows a neutral note so the
   * dispatcher knows the re-upload was intentional and the duplicate
   * detection still works — it just isn't blocking them this time.
   * The bulk upload path never reaches this flag; identical bytes are
   * still short-circuited with `skipped: true`.
   */
  sameAsLastImport?: boolean;
  /**
   * Task #435: per-row drop diagnostics for every row the extractor
   * saw but couldn't turn into a punch. Rendered in the dialog as a
   * "Dropped" breakdown grouped by typed reason so the dispatcher
   * can fix obvious problems (missing alias, wrong week, …) BEFORE
   * confirming the upload.
   */
  droppedRows?: CustomerPreviewDroppedRow[];
}

export interface CustomerPreviewDroppedRow {
  reason:
    | "no_driver_match"
    | "not_a_driver_alias"
    | "outside_week"
    | "duplicate_collapsed"
    | "extraction_failed"
    | "unknown";
  detail: string | null;
  rawRow: {
    driverNameOnDoc: string | null;
    badgeOrId: string | null;
    date: string | null;
    timeIn: string | null;
    timeOut: string | null;
    hours: number | null;
  };
}

const DROP_REASON_LABEL: Record<
  CustomerPreviewDroppedRow["reason"],
  string
> = {
  no_driver_match: "no driver match",
  not_a_driver_alias: "marked not a driver",
  outside_week: "outside this week",
  duplicate_collapsed: "duplicate (collapsed)",
  extraction_failed: "extraction failed",
  unknown: "other",
};

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

export function CustomerPreviewDialog({
  preview,
  open,
  onOpenChange,
  onConfirmed,
  onAskClaude,
}: {
  preview: CustomerPreviewData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
  /**
   * Task #408: when set, the footer renders an "Ask Claude" button
   * that opens the per-customer chat drawer pre-loaded with file
   * context. The host wires this to the same drawer used by the
   * upload panel so the {week, customer} thread is reused.
   */
  onAskClaude?: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const confirmMutation = useConfirmCustomerFile();
  const discardMutation = useDiscardCustomerExtract();
  const aliasesQuery = useListDriverIdAliases();
  const allDrivers = useMemo(
    () =>
      (aliasesQuery.data?.drivers ?? []).filter((d) => d.ctUserId != null),
    [aliasesQuery.data],
  );
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  // Per-unmapped-id dispatcher pick: kfiId, or SKIP_PICK to leave dropped,
  // or "" before they've chosen. Resets when a new preview arrives.
  const [picks, setPicks] = useState<Record<string, string>>({});
  // Task #435: which drop-reason buckets are expanded inline. The
  // breakdown is collapsed by default to keep the dialog scannable;
  // clicking a reason expands the matching raw rows underneath.
  const [openDropReasons, setOpenDropReasons] = useState<
    Set<CustomerPreviewDroppedRow["reason"]>
  >(new Set());

  // Reset exclusions when a new preview arrives. Pre-fill each unmapped id's
  // picker: when the server returned a high-confidence fuzzy suggestion
  // (server-side floor is 0.85) we pre-pick it for a single-click confirm.
  // When nothing cleared the bar, default to SKIP (rows stay dropped this
  // upload only). "Not a driver — never import" must be an ACTIVE choice —
  // it permanently ignores the badge for this customer, and defaulting to
  // it nearly buried a real driver (Aldo Lunar, 2026-08-04).
  useEffect(() => {
    setExcluded(new Set());
    setOpenDropReasons(new Set());
    if (!preview) {
      setPicks({});
      return;
    }
    const initial: Record<string, string> = {};
    for (const u of preview.unmappedIds) {
      const top = u.suggestions?.[0];
      initial[u.id] = top ? top.kfiId : SKIP_PICK;
    }
    setPicks(initial);
  }, [preview]);

  // Group rows by driver so the dispatcher can scan one person at a time —
  // matches how the weekly dashboard is organized.
  const groups = useMemo(() => {
    if (!preview) return [] as Array<{
      key: string;
      driverName: string | null;
      kfiId: string;
      rows: CustomerPreviewRow[];
    }>;
    const byKfi = new Map<
      string,
      { key: string; driverName: string | null; kfiId: string; rows: CustomerPreviewRow[] }
    >();
    for (const r of preview.rows) {
      const g = byKfi.get(r.kfiId);
      if (g) {
        g.rows.push(r);
      } else {
        byKfi.set(r.kfiId, {
          key: r.kfiId,
          driverName: r.driverName,
          kfiId: r.kfiId,
          rows: [r],
        });
      }
    }
    // Sort groups by driver name (kfiId fallback) for a stable, scannable layout.
    return [...byKfi.values()].sort((a, b) => {
      const an = (a.driverName ?? a.kfiId).toLowerCase();
      const bn = (b.driverName ?? b.kfiId).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
  }, [preview]);

  if (!preview) return null;

  const toggleExclude = (index: number) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const includedCount = preview.rows.length - excluded.size;

  // Build the alias payload from picks: only ids the dispatcher mapped to a
  // real driver (skipped / unselected ids are omitted, leaving those rows
  // dropped as today).
  const mapNewAliases = preview.unmappedIds
    .map((u) => {
      const kfiId = picks[u.id];
      if (!kfiId || kfiId === SKIP_PICK || kfiId === IGNORE_PICK) return null;
      return { externalId: u.id, kfiId, sampleName: u.sampleName ?? null };
    })
    .filter((a): a is { externalId: string; kfiId: string; sampleName: string | null } => a !== null);
  // Persist "not a driver — never import for this customer" decisions so
  // future uploads silently drop these ids instead of nagging.
  const addToIgnore = preview.unmappedIds
    .filter((u) => picks[u.id] === IGNORE_PICK)
    .map((u) => ({ externalId: u.id, sampleName: u.sampleName ?? null }));
  const mappedCount = mapNewAliases.length;
  const ignoredCount = addToIgnore.length;
  const unresolvedPicks = preview.unmappedIds.filter(
    (u) => !picks[u.id],
  ).length;

  const onConfirm = () => {
    confirmMutation.mutate(
      {
        weekStart: preview.weekStart,
        data: {
          customer: preview.customer,
          sampleId: preview.sampleId,
          excludedIndices: [...excluded].sort((a, b) => a - b),
          mapNewAliases: mapNewAliases.length > 0 ? mapNewAliases : undefined,
          addToIgnore: addToIgnore.length > 0 ? addToIgnore : undefined,
        },
      },
      {
        onSuccess: (body) => {
          const unmapped = body.unmappedIds ?? [];
          if (unmapped.length > 0) {
            const formatted = unmapped
              .map((u) => (u.sampleName ? `${u.id} (${u.sampleName})` : u.id))
              .join(", ");
            toast({
              title: t("customerPreview.importedUnknown", {
                count: unmapped.length,
                customer: preview.customer,
              }),
              description: t("customerPreview.importedUnknownDesc", {
                count: body.punchesUpserted ?? 0,
                ids: formatted,
              }),
              variant: "destructive",
            });
          } else {
            toast({
              title: t("customerPreview.importedTitle", {
                customer: preview.customer,
              }),
              description: t("customerPreview.importedDesc", {
                count: body.punchesUpserted ?? 0,
              }),
            });
          }
          onConfirmed();
          onOpenChange(false);
        },
        onError: (err) => {
          toast({
            title: t("customerPreview.importFailedTitle", {
              customer: preview.customer,
            }),
            description: errMessage(err, t("customerPreview.importFailedFallback")),
            variant: "destructive",
          });
        },
      },
    );
  };

  const onCancel = () => {
    if (confirmMutation.isPending) return;
    // Discard the stashed bytes immediately so we don't keep payroll
    // files around for the full 24h TTL when we know they'll never be
    // confirmed. Fire-and-forget — the dialog closes regardless because
    // the cleanup job is the safety net.
    discardMutation.mutate({
      weekStart: preview.weekStart,
      sampleId: preview.sampleId,
    });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && confirmMutation.isPending) return;
        if (!o) {
          discardMutation.mutate({
            weekStart: preview.weekStart,
            sampleId: preview.sampleId,
          });
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="font-display">
            {t("customerPreview.reviewTitle", { customer: preview.customer })}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{preview.fileName}</span> ·{" "}
            {t("customerPreview.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {/* Compact at-a-glance status — replaces the old stacked banner wall
              so the data table isn't buried. Lane + counts + replace note in
              one row; rarer warnings stay below. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            {preview.extractSource ? (
              <span
                className={
                  preview.extractSource === "ai"
                    ? "inline-flex items-center rounded border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-0.5 font-medium text-amber-900 dark:text-amber-200"
                    : "inline-flex items-center rounded border border-border bg-card px-2 py-0.5 font-medium"
                }
                data-testid="text-extract-source"
                title={
                  preview.extractSource === "ai"
                    ? t("customerPreview.aiReviewHint")
                    : t("customerPreview.cacheWarmedTitle")
                }
              >
                {preview.extractSource === "ai"
                  ? t("customerPreview.ai")
                  : preview.extractSource === "cache"
                    ? t("customerPreview.learnedSchema")
                    : t("customerPreview.builtinParser")}
              </span>
            ) : null}
            <span className="font-medium text-foreground">
              {t("customerPreview.statusPunches", { count: includedCount })}
            </span>
            <span className="text-muted-foreground">
              {t("customerPreview.statusDrivers", { count: groups.length })}
            </span>
            {preview.unmappedIds.length > 0 ? (
              <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
                <AlertCircle className="h-3.5 w-3.5" />
                {t("customerPreview.statusNeedAttention", {
                  count: preview.unmappedIds.length,
                })}
              </span>
            ) : null}
            {preview.droppedRows && preview.droppedRows.length > 0 ? (
              <span className="text-muted-foreground">
                {t("customerPreview.statusDropped", {
                  count: preview.droppedRows.length,
                })}
              </span>
            ) : null}
            <span
              className="ml-auto text-muted-foreground"
              data-testid={
                preview.existingPunchCount > 0
                  ? "text-replace-warning"
                  : undefined
              }
            >
              {preview.existingPunchCount > 0
                ? t("customerPreview.replaceWarning", {
                    count: preview.existingPunchCount,
                    existing: preview.existingPunchCount,
                    included: includedCount,
                    customer: preview.customer,
                  })
                : t("customerPreview.willImport", {
                    count: includedCount,
                    customer: preview.customer,
                  })}
            </span>
          </div>
          {preview.extractionTruncated ? (
            <div
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-50/60 dark:bg-red-950/20 px-3 py-2 text-xs text-red-900 dark:text-red-200"
              data-testid="text-truncated-warning"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                {preview.failedChunks && preview.failedChunks > 0
                  ? t("customerPreview.truncatedChunks", {
                      count: preview.failedChunks,
                    })
                  : t("customerPreview.truncated")}
              </span>
            </div>
          ) : null}
          {preview.sameAsLastImport ? (
            <div
              className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              data-testid="text-same-as-last-import"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{t("customerPreview.sameAsLastImport")}</span>
            </div>
          ) : null}
          {preview.geminiFallbackUsed ? (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
              data-testid="text-gemini-fallback-warning"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{t("customerPreview.geminiFallback")}</span>
            </div>
          ) : null}
          {preview.unmappedIds.length > 0 && (
            <div
              className="rounded-md border border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 space-y-2"
              data-testid="text-unmapped-warning"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {t("customerPreview.unmappedHeadline", {
                    count: preview.unmappedIds.length,
                  })}
                </span>
              </div>
              <div className="space-y-1.5 max-h-[30vh] overflow-auto">
                {preview.unmappedIds.map((u) => {
                  const suggestions = u.suggestions ?? [];
                  const suggestedKfiId = suggestions[0]?.kfiId;
                  const picked = picks[u.id] ?? "";
                  // Show top suggestions first, then the rest of the roster
                  // (deduped) so a confident match is a single click.
                  const seen = new Set<string>();
                  const orderedDrivers: typeof allDrivers = [];
                  for (const s of suggestions) {
                    const d = allDrivers.find((x) => x.kfiId === s.kfiId);
                    if (d && !seen.has(d.kfiId)) {
                      seen.add(d.kfiId);
                      orderedDrivers.push(d);
                    }
                  }
                  for (const d of allDrivers) {
                    if (!seen.has(d.kfiId)) {
                      seen.add(d.kfiId);
                      orderedDrivers.push(d);
                    }
                  }
                  return (
                    <div
                      key={u.id}
                      className="flex flex-wrap items-center gap-2 rounded border border-amber-500/20 bg-background/60 px-2 py-1.5"
                      data-testid={`row-unmapped-${u.id}`}
                    >
                      <div className="flex flex-col min-w-[180px]">
                        <span className="font-medium text-foreground">
                          {u.sampleName
                            ? formatPersonName(u.sampleName)
                            : t("customerPreview.noNameOnDoc")}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {u.id.startsWith("name:")
                            ? t("customerPreview.rows", { count: u.count })
                            : t("customerPreview.rowsWithId", {
                                count: u.count,
                                id: u.id,
                              })}
                        </span>
                      </div>
                      <div className="flex-1 min-w-[240px]">
                        <DriverPicker
                          testId={`select-unmapped-${u.id}`}
                          value={picked}
                          onChange={(v) =>
                            setPicks((p) => ({ ...p, [u.id]: v }))
                          }
                          drivers={orderedDrivers}
                          suggestedKfiId={suggestedKfiId}
                          skipValue={SKIP_PICK}
                          ignoreValue={IGNORE_PICK}
                          labels={{
                            skip: t("customerPreview.skipLeaveDropped"),
                            ignore: t("customerPreview.notADriver", {
                              customer: preview.customer,
                            }),
                            placeholder: t("customerPreview.pickDriverPlaceholder"),
                            search: t("customerPreview.pickDriverPlaceholder"),
                            noResults: t("customerPreview.noDriversLoaded"),
                            suggested: t("customerPreview.suggested"),
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              {mappedCount > 0 ? (
                <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
                  {t("customerPreview.willSaveMappings", { count: mappedCount })}
                </div>
              ) : null}
              {ignoredCount > 0 ? (
                <div
                  className="text-[11px] text-muted-foreground"
                  data-testid="text-ignore-summary"
                >
                  {t("customerPreview.willRememberIgnored", {
                    count: ignoredCount,
                    customer: preview.customer,
                  })}
                </div>
              ) : null}
              {unresolvedPicks > 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  {t("customerPreview.noPickYet", { count: unresolvedPicks })}
                </div>
              ) : null}
            </div>
          )}
          {preview.droppedRows && preview.droppedRows.length > 0 ? (
            <DroppedBreakdown
              rows={preview.droppedRows}
              open={openDropReasons}
              onToggle={(reason) =>
                setOpenDropReasons((prev) => {
                  const next = new Set(prev);
                  if (next.has(reason)) next.delete(reason);
                  else next.add(reason);
                  return next;
                })
              }
            />
          ) : null}
          {preview.autoIgnoredIds && preview.autoIgnoredIds.length > 0 ? (
            <div
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
              data-testid="text-auto-ignored"
            >
              {t("customerPreview.autoIgnored", {
                count: preview.autoIgnoredIds.length,
                customer: preview.customer,
                ids: preview.autoIgnoredIds
                  .map((u) =>
                    u.sampleName ? `${u.id} (${u.sampleName})` : u.id,
                  )
                  .join(", "),
              })}
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead className="w-10">{t("customerPreview.headerKeep")}</TableHead>
                <TableHead>{t("customerPreview.headerSource")}</TableHead>
                <TableHead>{t("customerPreview.headerDate")}</TableHead>
                <TableHead>{t("customerPreview.headerIn")}</TableHead>
                <TableHead>{t("customerPreview.headerOut")}</TableHead>
                <TableHead className="text-right">{t("customerPreview.headerHours")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <DriverGroup
                  key={g.key}
                  driverName={g.driverName}
                  kfiId={g.kfiId}
                  rows={g.rows}
                  excluded={excluded}
                  onToggle={toggleExclude}
                />
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="flex items-center sm:justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {t("customerPreview.rowsSelected", {
              count: preview.rows.length,
              included: includedCount,
              total: preview.rows.length,
            })}
            {excluded.size > 0
              ? t("customerPreview.excludedSuffix", { count: excluded.size })
              : ""}
            {mappedCount > 0
              ? t("customerPreview.plusFromPicked", { count: mappedCount })
              : ""}
          </div>
          <div className="flex gap-2">
            {onAskClaude ? (
              <Button
                variant="outline"
                onClick={onAskClaude}
                disabled={confirmMutation.isPending}
                data-testid="button-preview-ask-claude"
                title={`Ask Claude about ${preview.fileName}`}
              >
                <MessageSquare className="mr-2 h-4 w-4" />
                Ask Claude
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={onCancel}
              disabled={confirmMutation.isPending}
              data-testid="button-cancel-import"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={onConfirm}
              disabled={
                confirmMutation.isPending ||
                (includedCount === 0 && mappedCount === 0)
              }
              data-testid="button-confirm-import"
            >
              {confirmMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="mr-2 h-4 w-4" />
              )}
              {t("customerPreview.confirmImport")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DroppedBreakdown({
  rows,
  open,
  onToggle,
}: {
  rows: CustomerPreviewDroppedRow[];
  open: Set<CustomerPreviewDroppedRow["reason"]>;
  onToggle: (reason: CustomerPreviewDroppedRow["reason"]) => void;
}) {
  // Bucket rows by typed reason while preserving server order so the
  // breakdown numbers line up with the rows displayed when expanded.
  const groups = useMemo(() => {
    const byReason = new Map<
      CustomerPreviewDroppedRow["reason"],
      CustomerPreviewDroppedRow[]
    >();
    for (const r of rows) {
      const arr = byReason.get(r.reason) ?? [];
      arr.push(r);
      byReason.set(r.reason, arr);
    }
    return [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [rows]);
  const summary = groups
    .map(([reason, items]) => `${items.length} ${DROP_REASON_LABEL[reason]}`)
    .join(", ");
  return (
    <div
      className="rounded-md border border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 space-y-1.5"
      data-testid="text-dropped-breakdown"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          <span className="font-medium">
            {rows.length} row{rows.length === 1 ? "" : "s"} dropped:
          </span>{" "}
          {summary}. Fix obvious problems (missing alias, wrong week, …)
          before confirming.
        </span>
      </div>
      <div className="space-y-1">
        {groups.map(([reason, items]) => {
          const isOpen = open.has(reason);
          return (
            <div key={reason}>
              <button
                type="button"
                onClick={() => onToggle(reason)}
                className="text-[11px] underline-offset-2 hover:underline font-mono"
                data-testid={`button-drop-reason-${reason}`}
                aria-expanded={isOpen}
              >
                {isOpen ? "▾" : "▸"} {DROP_REASON_LABEL[reason]} ({items.length})
              </button>
              {isOpen ? (
                <div
                  className="mt-1 ml-3 rounded border border-amber-500/20 bg-background/60 overflow-hidden"
                  data-testid={`rows-drop-reason-${reason}`}
                >
                  <table className="w-full text-[11px]">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="text-left px-2 py-1 font-medium">Name</th>
                        <th className="text-left px-2 py-1 font-medium">Badge</th>
                        <th className="text-left px-2 py-1 font-medium">Date</th>
                        <th className="text-left px-2 py-1 font-medium">In</th>
                        <th className="text-left px-2 py-1 font-medium">Out</th>
                        <th className="text-left px-2 py-1 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r, i) => (
                        <tr
                          key={i}
                          className="border-t border-amber-500/10 font-mono"
                        >
                          <td className="px-2 py-1">
                            {r.rawRow.driverNameOnDoc ?? "—"}
                          </td>
                          <td className="px-2 py-1">
                            {r.rawRow.badgeOrId ?? "—"}
                          </td>
                          <td className="px-2 py-1">{r.rawRow.date ?? "—"}</td>
                          <td className="px-2 py-1">
                            {r.rawRow.timeIn ?? "—"}
                          </td>
                          <td className="px-2 py-1">
                            {r.rawRow.timeOut ?? "—"}
                          </td>
                          <td className="px-2 py-1 font-sans">
                            {r.detail ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DriverGroup({
  driverName,
  kfiId,
  rows,
  excluded,
  onToggle,
}: {
  driverName: string | null;
  kfiId: string;
  rows: CustomerPreviewRow[];
  excluded: Set<number>;
  onToggle: (index: number) => void;
}) {
  const { t } = useTranslation();
  const includedHours = rows.reduce(
    (acc, r) => (excluded.has(r.index) ? acc : acc + r.hours),
    0,
  );
  return (
    <>
      <TableRow
        className="bg-secondary/60 hover:bg-secondary/60"
        data-testid={`row-driver-group-${kfiId}`}
      >
        <TableCell colSpan={5} className="py-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">
              {driverName ?? kfiId}
            </span>
            <span className="fin-num text-xs text-muted-foreground">
              {kfiId}
            </span>
            <span className="text-xs text-muted-foreground">
              · {t("customerPreview.rows", { count: rows.length })}
            </span>
          </div>
        </TableCell>
        <TableCell className="fin-num py-2 text-right text-sm font-semibold">
          {includedHours.toFixed(2)}
        </TableCell>
      </TableRow>
      {rows.map((r) => {
        const isExcluded = excluded.has(r.index);
        return (
          <TableRow
            key={r.index}
            data-testid={`row-preview-${r.index}`}
            className={isExcluded ? "opacity-50" : undefined}
          >
            <TableCell className="py-2.5">
              <Checkbox
                checked={!isExcluded}
                onCheckedChange={() => onToggle(r.index)}
                data-testid={`checkbox-keep-${r.index}`}
                aria-label={t("customerPreview.keepRowAria", { n: r.index + 1 })}
              />
            </TableCell>
            <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
              {r.sourceRow}
            </TableCell>
            <TableCell className="fin-num text-sm">{r.date}</TableCell>
            <TableCell className="fin-num text-sm">{r.clockIn}</TableCell>
            <TableCell className="fin-num text-sm">{r.clockOut}</TableCell>
            <TableCell className="fin-num text-right text-sm">
              {r.hours.toFixed(2)}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
