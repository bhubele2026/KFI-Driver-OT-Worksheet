import { useEffect, useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { AlertCircle, Loader2, UploadCloud } from "lucide-react";

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
  aiFallback?: boolean;
  aiFallbackReason?: string | null;
}

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
}: {
  preview: CustomerPreviewData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
}) {
  const { toast } = useToast();
  const confirmMutation = useConfirmCustomerFile();
  const discardMutation = useDiscardCustomerExtract();
  const aliasesQuery = useListDriverIdAliases();
  const allDrivers = useMemo(
    () => aliasesQuery.data?.drivers ?? [],
    [aliasesQuery.data],
  );
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  // Per-unmapped-id dispatcher pick: kfiId, or SKIP_PICK to leave dropped,
  // or "" before they've chosen. Resets when a new preview arrives.
  const [picks, setPicks] = useState<Record<string, string>>({});

  // Reset exclusions when a new preview arrives. Pre-fill each unmapped id's
  // picker with its top fuzzy suggestion (if any) so the common case is a
  // single-click "looks right, confirm". Dispatchers can override or skip.
  useEffect(() => {
    setExcluded(new Set());
    if (!preview) {
      setPicks({});
      return;
    }
    const initial: Record<string, string> = {};
    for (const u of preview.unmappedIds) {
      const top = u.suggestions?.[0];
      initial[u.id] = top ? top.kfiId : "";
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
              title: `${preview.customer} imported with ${unmapped.length} unknown ${
                unmapped.length === 1 ? "badge" : "badges"
              }`,
              description: `Imported ${body.punchesUpserted ?? 0} punches. These IDs aren't in the KFI roster, so their rows were skipped: ${formatted}.`,
              variant: "destructive",
            });
          } else {
            toast({
              title: `${preview.customer} imported`,
              description: `Imported ${body.punchesUpserted ?? 0} punches.`,
            });
          }
          onConfirmed();
          onOpenChange(false);
        },
        onError: (err) => {
          toast({
            title: `${preview.customer} import failed`,
            description: errMessage(err, "Confirm failed"),
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
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-display">
            Review {preview.customer} upload
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{preview.fileName}</span> ·
            Nothing is saved until you confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {preview.aiFallback ? (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-100/70 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
              data-testid="text-ai-fallback-warning"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                <strong>AI fallback used.</strong> The built-in parser for{" "}
                {preview.customer} returned no rows
                {preview.aiFallbackReason
                  ? ` (${preview.aiFallbackReason})`
                  : ""}
                , so the file was read by AI instead. The format has likely
                changed — review every row carefully before confirming and
                flag the change to engineering so the parser can be updated.
              </span>
            </div>
          ) : null}
          {preview.existingPunchCount > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span data-testid="text-replace-warning">
                Confirming will replace{" "}
                <strong>{preview.existingPunchCount}</strong> existing{" "}
                {preview.existingPunchCount === 1 ? "punch" : "punches"} for{" "}
                {preview.customer} in this week with{" "}
                <strong>{includedCount}</strong> new{" "}
                {includedCount === 1 ? "row" : "rows"} from this file. Manual,
                edited, and locked driver-week rows are preserved (and are not
                counted in the replacement total).
              </span>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Will import <strong>{includedCount}</strong>{" "}
              {includedCount === 1 ? "punch" : "punches"}. No existing{" "}
              {preview.customer} rows for this week will change.
            </div>
          )}
          {preview.unmappedIds.length > 0 && (
            <div
              className="rounded-md border border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 space-y-2"
              data-testid="text-unmapped-warning"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {preview.unmappedIds.length}{" "}
                  {preview.unmappedIds.length === 1 ? "badge" : "badges"} in
                  this file don't match any KFI driver. Pick the matching
                  driver below and we'll remember the mapping so future
                  uploads import automatically. Leave any row as
                  <em> Skip — leave dropped</em> to keep the rows dropped.
                </span>
              </div>
              <div className="space-y-1.5">
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
                            : "(no name on doc)"}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {u.id} · {u.count}{" "}
                          {u.count === 1 ? "row" : "rows"}
                        </span>
                      </div>
                      <div className="flex-1 min-w-[240px]">
                        <Select
                          value={picked}
                          onValueChange={(v) =>
                            setPicks((p) => ({ ...p, [u.id]: v }))
                          }
                        >
                          <SelectTrigger
                            className="h-8 text-xs"
                            data-testid={`select-unmapped-${u.id}`}
                          >
                            <SelectValue placeholder="Pick a driver…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP_PICK}>
                              Skip — leave dropped (this upload only)
                            </SelectItem>
                            <SelectItem value={IGNORE_PICK}>
                              Not a driver — never import for {preview.customer}
                            </SelectItem>
                            {orderedDrivers.length === 0 ? (
                              <SelectItem value="__no_drivers" disabled>
                                No drivers loaded — refresh Connecteam first
                              </SelectItem>
                            ) : null}
                            {orderedDrivers.map((d) => {
                              const isSuggested = d.kfiId === suggestedKfiId;
                              return (
                                <SelectItem key={d.kfiId} value={d.kfiId}>
                                  <span className="font-medium">
                                    {formatPersonName(d.name)}
                                  </span>
                                  <span className="font-mono text-[10px] text-muted-foreground ml-2">
                                    {d.kfiId} · {d.customer}
                                  </span>
                                  {isSuggested ? (
                                    <span className="ml-2 text-[10px] text-emerald-600 dark:text-emerald-400">
                                      suggested
                                    </span>
                                  ) : null}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  );
                })}
              </div>
              {mappedCount > 0 ? (
                <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
                  Will save {mappedCount}{" "}
                  {mappedCount === 1 ? "mapping" : "mappings"} on confirm and
                  re-import the previously-dropped rows.
                </div>
              ) : null}
              {ignoredCount > 0 ? (
                <div
                  className="text-[11px] text-muted-foreground"
                  data-testid="text-ignore-summary"
                >
                  Will remember {ignoredCount}{" "}
                  {ignoredCount === 1 ? "id" : "ids"} as "not a driver" for{" "}
                  {preview.customer} — future uploads will skip{" "}
                  {ignoredCount === 1 ? "it" : "them"} silently. Undo from
                  /admin/driver-id-aliases.
                </div>
              ) : null}
              {unresolvedPicks > 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  {unresolvedPicks}{" "}
                  {unresolvedPicks === 1 ? "id has" : "ids have"} no pick yet
                  — pick a driver or choose Skip.
                </div>
              ) : null}
            </div>
          )}
          {preview.autoIgnoredIds && preview.autoIgnoredIds.length > 0 ? (
            <div
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
              data-testid="text-auto-ignored"
            >
              Silently dropped{" "}
              <strong>{preview.autoIgnoredIds.length}</strong>{" "}
              {preview.autoIgnoredIds.length === 1 ? "id" : "ids"} previously
              marked "not a driver" for {preview.customer}:{" "}
              <span className="font-mono">
                {preview.autoIgnoredIds
                  .map((u) =>
                    u.sampleName ? `${u.id} (${u.sampleName})` : u.id,
                  )
                  .join(", ")}
              </span>
              . Manage from /admin/driver-id-aliases.
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead className="w-10">Keep</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>In</TableHead>
                <TableHead>Out</TableHead>
                <TableHead className="text-right">Hours</TableHead>
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
            {includedCount} of {preview.rows.length}{" "}
            {preview.rows.length === 1 ? "row" : "rows"} selected
            {excluded.size > 0 ? ` · ${excluded.size} excluded` : ""}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={onCancel}
              disabled={confirmMutation.isPending}
              data-testid="button-cancel-import"
            >
              Cancel
            </Button>
            <Button
              onClick={onConfirm}
              disabled={confirmMutation.isPending || includedCount === 0}
              data-testid="button-confirm-import"
            >
              {confirmMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="mr-2 h-4 w-4" />
              )}
              Confirm import
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const includedHours = rows.reduce(
    (acc, r) => (excluded.has(r.index) ? acc : acc + r.hours),
    0,
  );
  return (
    <>
      <TableRow
        className="bg-muted/30 hover:bg-muted/30"
        data-testid={`row-driver-group-${kfiId}`}
      >
        <TableCell colSpan={5} className="py-1.5">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-xs">
              {driverName ?? kfiId}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {kfiId}
            </span>
            <span className="text-[10px] text-muted-foreground">
              · {rows.length} {rows.length === 1 ? "row" : "rows"}
            </span>
          </div>
        </TableCell>
        <TableCell className="py-1.5 text-right font-mono text-xs">
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
            <TableCell>
              <Checkbox
                checked={!isExcluded}
                onCheckedChange={() => onToggle(r.index)}
                data-testid={`checkbox-keep-${r.index}`}
                aria-label={`Keep row ${r.index + 1}`}
              />
            </TableCell>
            <TableCell className="text-[11px] text-muted-foreground font-mono">
              {r.sourceRow}
            </TableCell>
            <TableCell className="font-mono text-xs">{r.date}</TableCell>
            <TableCell className="font-mono text-xs">{r.clockIn}</TableCell>
            <TableCell className="font-mono text-xs">{r.clockOut}</TableCell>
            <TableCell className="font-mono text-xs text-right">
              {r.hours.toFixed(2)}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
