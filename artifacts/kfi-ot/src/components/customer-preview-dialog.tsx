import { useEffect, useMemo, useState } from "react";
import {
  useConfirmCustomerFile,
  useDiscardCustomerExtract,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, Loader2, UploadCloud } from "lucide-react";

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

export interface CustomerPreviewData {
  customer: string;
  fileName: string;
  weekStart: string;
  sampleId: number;
  rows: CustomerPreviewRow[];
  unmappedIds: Array<{ id: string; count: number; sampleName: string | null }>;
  existingPunchCount: number;
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
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  // Reset exclusions when a new preview arrives.
  useEffect(() => {
    setExcluded(new Set());
  }, [preview?.sampleId]);

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

  const onConfirm = () => {
    confirmMutation.mutate(
      {
        weekStart: preview.weekStart,
        data: {
          customer: preview.customer,
          sampleId: preview.sampleId,
          excludedIndices: [...excluded].sort((a, b) => a - b),
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
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span data-testid="text-unmapped-warning">
                Dropped rows for unknown{" "}
                {preview.unmappedIds.length === 1 ? "badge" : "badges"}:{" "}
                {preview.unmappedIds
                  .map((u) =>
                    u.sampleName ? `${u.id} (${u.sampleName})` : u.id,
                  )
                  .join(", ")}
                . Add the mapping under Admin and re-upload to recover them.
              </span>
            </div>
          )}
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
