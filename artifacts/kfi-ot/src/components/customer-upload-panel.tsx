import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import {
  useGetCustomerUploadStatus,
  useGetMe,
  useGetAllowedTimezones,
  useMarkCustomerInactive,
  getGetCustomerUploadStatusQueryKey,
  getGetWeekSummaryQueryKey,
  getListInactiveCustomersQueryKey,
} from "@workspace/api-client-react";
import {
  useCustomerUploads,
  useWeekUploadState,
  useElapsedTicker,
} from "@/hooks/use-customer-uploads";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  FileQuestion,
  FolderUp,
  X,
} from "lucide-react";
import { NewCustomerDialog } from "@/components/new-customer-dialog";
import { CustomerPreviewDialog } from "@/components/customer-preview-dialog";

// Note: in-flight upload state (per-row + bulk), progress polling, AbortControllers,
// and the extract→preview/confirm pipeline now live in `hooks/use-customer-uploads`.
// Lifting them above the route means navigating away from the dashboard mid-upload
// no longer aborts the fetch or drops the preview.

// Single source of truth for the file extensions any customer row will
// accept in its `<input accept=...>` and in the bulk dropzone. Every
// row accepts every supported extension; the server routes by the
// explicit customer field + content rather than filename and falls
// through to AI extraction when the deterministic parser can't handle
// the file. Keep this in sync with `isAcceptedUpload` below.
const UNIVERSAL_ACCEPT =
  ".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,.heic,.heif,.webp";

// Translate raw server errors into copy a payroll dispatcher can act
// on. Most AI-extract failures bubble up the underlying Gemini message
// (e.g. truncated JSON, "model did not return valid JSON", or a column
// position) which is noise to the operator. Keep the original around
// in the server logs; surface this in the toast instead.
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

function looksLikeFormatDrift(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("0 punches") ||
    lower.includes("format may have changed") ||
    lower.includes("format has changed")
  );
}

function readEntryAsFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

function readDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    reader.readEntries(
      (entries) => resolve(entries),
      () => resolve([]),
    );
  });
}

async function collectFilesFromEntries(
  entries: FileSystemEntry[],
): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry) => {
    if (entry.isFile) {
      const file = await readEntryAsFile(entry as FileSystemFileEntry);
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most ~100 entries per call; keep reading
      // until it returns an empty batch.
      for (;;) {
        const batch = await readDirectoryEntries(reader);
        if (batch.length === 0) break;
        for (const child of batch) {
          await walk(child);
        }
      }
    }
  };
  for (const entry of entries) {
    await walk(entry);
  }
  return out;
}

export function CustomerUploadPanel({ weekStart }: { weekStart: string }) {
  const { t } = useTranslation();
  const { data: statuses } = useGetCustomerUploadStatus(weekStart);
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const bulkInputRef = useRef<HTMLInputElement>(null);
  const bulkItemRefs = useRef<Record<number, HTMLLIElement | null>>({});
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newInitialFile, setNewInitialFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepth = useRef(0);
  // When the user is dragging over a specific row, suppress the whole-panel
  // overlay so the per-row drop target reads as the active target.
  const [rowDragCustomer, setRowDragCustomer] = useState<string | null>(null);
  const rowDragDepth = useRef<Record<string, number>>({});
  const markInactiveMutation = useMarkCustomerInactive();
  const [overrideTz, setOverrideTz] = useState<string>("__auto__");
  const { data: allowedTzs } = useGetAllowedTimezones();

  // Task #316: in-flight upload state (per-row + bulk) lives in an
  // app-level provider keyed by weekStart. The panel reads its slice
  // here so that navigating to a driver page mid-upload and back
  // re-renders the same spinner / preview without re-issuing requests.
  const store = useCustomerUploads();
  const { rowState, bulkItems, bulkRunning, pendingPreviews } =
    useWeekUploadState(weekStart);
  // Auto-pop the first stashed preview as the dialog payload. Closing
  // the dialog removes it from the queue; the next pending preview (if
  // any) takes its place on the following render.
  const preview = pendingPreviews[0] ?? null;
  const previewOpen = preview !== null;

  const markInactive = (customer: string) => {
    markInactiveMutation.mutate(
      { data: { customer } },
      {
        onSuccess: () => {
          toast({
            title: t("customerUpload.hidTitle", { customer }),
            description: t("customerUpload.hidDesc"),
          });
          queryClient.invalidateQueries({
            queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
          });
          queryClient.invalidateQueries({
            queryKey: getListInactiveCustomersQueryKey(),
          });
        },
        onError: (err) =>
          toast({
            title: t("customerUpload.markInactiveFailedTitle"),
            description: errMessage(err, t("customerUpload.markInactiveFailedFallback")),
            variant: "destructive",
          }),
      },
    );
  };

  // 1Hz tick to drive the elapsed-seconds badge while any row is uploading.
  // Cheap — the interval auto-clears when none are.
  useElapsedTicker(Object.values(rowState).some((r) => r.uploading));

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
    });
    queryClient.invalidateQueries({
      queryKey: getGetWeekSummaryQueryKey(weekStart),
    });
  };

  // Per-row two-step preview flow (extract → confirm via dialog).
  const extractFor = (customer: string, file: File) =>
    void store.extractFor(weekStart, customer, file, overrideTz);
  const cancelRowUpload = (customer: string) =>
    store.cancelRowUpload(weekStart, customer);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars

  const isAcceptedUpload = (name: string): boolean => {
    const lower = name.toLowerCase();
    return (
      lower.endsWith(".pdf") ||
      lower.endsWith(".xlsx") ||
      lower.endsWith(".xls") ||
      lower.endsWith(".csv") ||
      /\.(jpe?g|png|heic|heif|webp)$/i.test(lower)
    );
  };

  const processCollectedFiles = (collected: File[]) => {
    if (collected.length === 0) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of collected) {
      if (isAcceptedUpload(f.name)) {
        accepted.push(f);
      } else {
        rejected.push(f.name);
      }
    }
    if (rejected.length > 0) {
      toast({
        title: t("customerUpload.skippedUnsupportedTitle", { count: rejected.length }),
        description: t("customerUpload.skippedUnsupportedDesc", { names: rejected.join(", ") }),
        variant: "destructive",
      });
    }
    if (accepted.length > 0) void runBulk(accepted);
  };

  const classifyFile = (file: File): string | null => {
    const lower = file.name.toLowerCase();
    if (!isAcceptedUpload(lower)) return null;
    // Route by keyword only. The server now accepts any supported
    // extension on any customer row (extension-mismatched files fall
    // through to AI extraction), so we no longer gate by the customer's
    // deterministic parser extension list.
    for (const s of statuses ?? []) {
      if (!s.keywords || s.keywords.length === 0) continue;
      if (s.keywords.some((k) => lower.includes(k))) return s.customer;
    }
    return null;
  };

  // Task #316: delegate to the app-level store so an in-flight bulk
  // survives navigating away from /weeks/:weekStart. The panel-owned
  // `bulkItemRefs` are passed via the onFirstFailedIdx callback so
  // the "Show first failure" toast action can still scroll to and
  // highlight the row when the panel is mounted. If the user is
  // off-route when the toast fires, the click no-ops safely.
  const runBulk = (files: File[]) => {
    void store.runBulk(weekStart, files, classifyFile, overrideTz, (idx) => {
      const el = bulkItemRefs.current[idx];
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-destructive");
      window.setTimeout(() => {
        el.classList.remove("ring-2", "ring-destructive");
      }, 2000);
    });
  };

  const openNewWithFile = (file: File | null) => {
    setNewInitialFile(file);
    setNewOpen(true);
  };

  const dismissBulk = () => store.dismissBulk(weekStart);

  // Per-row drop: bypasses the filename-based classifier entirely and forces
  // the dropped file through the per-row extract route for that customer.
  // Multi-file or unsupported drops are rejected with a toast.
  const handleRowDragEnter = (
    customer: string,
    e: React.DragEvent<HTMLLIElement>,
  ) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    rowDragDepth.current[customer] =
      (rowDragDepth.current[customer] ?? 0) + 1;
    setRowDragCustomer(customer);
    // Cancel any whole-panel overlay state so the user sees the row target.
    dragDepth.current = 0;
    setIsDragOver(false);
  };

  const handleRowDragOver = (e: React.DragEvent<HTMLLIElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleRowDragLeave = (
    customer: string,
    e: React.DragEvent<HTMLLIElement>,
  ) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.max(0, (rowDragDepth.current[customer] ?? 0) - 1);
    rowDragDepth.current[customer] = next;
    if (next === 0 && rowDragCustomer === customer) {
      setRowDragCustomer(null);
    }
  };

  const handleRowDrop = (
    customer: string,
    e: React.DragEvent<HTMLLIElement>,
  ) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    rowDragDepth.current[customer] = 0;
    setRowDragCustomer(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    if (files.length > 1) {
      toast({
        title: t("customerUpload.dropSingleTitle"),
        description: t("customerUpload.dropSingleDesc", { count: files.length }),
        variant: "destructive",
      });
      return;
    }
    const file = files[0];
    const lower = file.name.toLowerCase();
    const ok =
      lower.endsWith(".pdf") ||
      lower.endsWith(".xlsx") ||
      lower.endsWith(".xls") ||
      lower.endsWith(".csv") ||
      /\.(jpe?g|png|heic|heif|webp)$/i.test(lower);
    if (!ok) {
      toast({
        title: t("customerUpload.unsupportedFileTitle"),
        description: t("customerUpload.unsupportedFileDesc", { name: file.name }),
        variant: "destructive",
      });
      return;
    }
    // Per-row drop intentionally bypasses filename-based routing — the
    // dispatcher picked the customer by aiming at this row, so we trust
    // that signal over the filename keyword.
    void extractFor(customer, file);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    if (bulkRunning) {
      toast({
        title: t("customerUpload.bulkBusyTitle"),
        description: t("customerUpload.bulkBusyDesc"),
        variant: "destructive",
      });
      return;
    }
    // We need to snapshot the items list now — `DataTransferItem` entries
    // are invalidated as soon as the drop event handler returns, so the
    // async folder traversal below would otherwise see an empty list.
    const items = e.dataTransfer.items
      ? Array.from(e.dataTransfer.items)
          .map((it) =>
            typeof it.webkitGetAsEntry === "function"
              ? it.webkitGetAsEntry()
              : null,
          )
          .filter((entry): entry is FileSystemEntry => entry !== null)
      : [];
    const fallbackFiles = Array.from(e.dataTransfer.files ?? []);
    void (async () => {
      const collected: File[] =
        items.length > 0
          ? await collectFilesFromEntries(items)
          : fallbackFiles;
      processCollectedFiles(collected);
    })();
  };

  return (
    <Card
      className={`relative overflow-hidden border-border/60 transition-colors ${
        isDragOver && !rowDragCustomer
          ? "ring-2 ring-primary ring-offset-2 ring-offset-background border-primary/60"
          : ""
      }`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !rowDragCustomer && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="rounded-lg border-2 border-dashed border-primary bg-background/95 px-6 py-4 shadow-lg flex items-center gap-3">
            <UploadCloud className="h-6 w-6 text-primary" />
            <div>
              <div className="font-display font-semibold text-sm">
                {t("customerUpload.dropZoneTitle")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("customerUpload.dropZoneSubtitle")}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="bg-muted/40 px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <div>
          <h3 className="font-display font-semibold text-base">
            {t("customerPanel.title")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("customerUpload.panelDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("customerUpload.tzLabel")}
            </span>
            <Select value={overrideTz} onValueChange={setOverrideTz}>
              <SelectTrigger
                className="h-8 w-[170px] text-xs"
                data-testid="select-upload-tz"
                title={t("customerUpload.tzTitle")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__" className="text-xs">
                  {t("customerUpload.tzAuto")}
                </SelectItem>
                {(allowedTzs?.allowed ?? []).map((tz) => (
                  <SelectItem key={tz} value={tz} className="text-xs">
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <input
            type="file"
            ref={bulkInputRef}
            accept={UNIVERSAL_ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void runBulk(files);
              e.target.value = "";
            }}
          />
          <input
            type="file"
            ref={folderInputRef}
            className="hidden"
            multiple
            // `webkitdirectory` makes the picker select a folder; the
            // browser then hands us every file inside it (recursively).
            // It's not in the React HTMLInputElement type yet, hence
            // the cast.
            {...({ webkitdirectory: "", directory: "" } as Record<
              string,
              string
            >)}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              processCollectedFiles(files);
            }}
          />
          <Button
            size="sm"
            disabled={bulkRunning}
            onClick={() => bulkInputRef.current?.click()}
          >
            {bulkRunning ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="mr-2 h-4 w-4" />
            )}
            {t("customerUpload.uploadAll")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkRunning}
            onClick={() => folderInputRef.current?.click()}
            title={t("customerUpload.folderTitle")}
            data-testid="button-upload-folder"
          >
            <FolderUp className="mr-2 h-4 w-4" />
            {t("customerUpload.folder")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openNewWithFile(null)}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {t("customerPanel.newCustomer")}
          </Button>
        </div>
      </div>
      {bulkItems.length > 0 && (
        <div className="border-b border-border bg-muted/20 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-display font-semibold text-sm">
              {bulkRunning
                ? t("customerUpload.uploadingHeader")
                : t("customerUpload.bulkResultsHeader")}
            </h4>
            {!bulkRunning && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={dismissBulk}
              >
                <X className="h-3 w-3 mr-1" />
                {t("common.dismiss")}
              </Button>
            )}
          </div>
          <ul className="space-y-1">
            {bulkItems.map((item, idx) => {
              const isUnknown = item.status === "unknown";
              const isError = item.status === "error";
              const driftHint =
                isError && item.error && looksLikeFormatDrift(item.error);
              return (
                <li
                  key={idx}
                  ref={(el) => {
                    bulkItemRefs.current[idx] = el;
                  }}
                  data-testid={`bulk-item-${idx}`}
                  data-status={item.status}
                  className={`flex items-start gap-2 text-xs py-1 px-2 rounded border ${
                    isError
                      ? "bg-destructive/5 border-destructive/40"
                      : "bg-background/60 border-border/40"
                  }`}
                >
                  <div className="shrink-0 mt-0.5">
                    {item.status === "pending" && (
                      <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
                    )}
                    {item.status === "uploading" && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    )}
                    {item.status === "success" && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    )}
                    {item.status === "warning" && (
                      <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    )}
                    {item.status === "skipped" && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    {item.status === "error" && (
                      <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                    )}
                    {item.status === "unknown" && (
                      <FileQuestion className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px] truncate">
                        {item.file.name}
                      </span>
                      {item.customer && (
                        <Badge
                          variant="secondary"
                          className="text-[10px]"
                        >
                          {item.customer}
                        </Badge>
                      )}
                      {item.status === "success" && (
                        <span className="text-[10px] text-muted-foreground">
                          {t("customerUpload.punchesImported", { count: item.punchesUpserted ?? 0 })}
                        </span>
                      )}
                      {item.status === "warning" && (
                        <span className="text-[10px] text-amber-700 dark:text-amber-400">
                          {t("customerUpload.importedUnknownBadges", {
                            count: item.unmappedCount ?? 0,
                            imported: item.punchesUpserted ?? 0,
                            unknown: item.unmappedCount ?? 0,
                          })}
                        </span>
                      )}
                      {item.status === "skipped" && (
                        <span className="text-[10px] text-muted-foreground">
                          {t("customerUpload.alreadyUpToDate")}
                        </span>
                      )}
                    </div>
                    {isError && (
                      <div
                        className="mt-1 text-destructive text-[11px] font-medium leading-snug"
                        data-testid={`bulk-item-error-${idx}`}
                      >
                        {item.error ?? t("customerUpload.uploadFailedFallback")}
                      </div>
                    )}
                    {driftHint && (
                      <div className="mt-1 text-[11px] text-amber-800 dark:text-amber-300 flex items-start gap-1">
                        <Lightbulb className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>{t("customerUpload.formatDriftHint")}</span>
                      </div>
                    )}
                    {isUnknown && (
                      <div className="mt-0.5 text-amber-800 dark:text-amber-300 text-[11px]">
                        {t("customerUpload.notKnownCustomer")}
                      </div>
                    )}
                  </div>
                  {isUnknown && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px] shrink-0"
                      onClick={() => openNewWithFile(item.file)}
                    >
                      <Sparkles className="h-3 w-3 mr-1" />
                      {t("customerPanel.newCustomer")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <ul className="divide-y divide-border">
        {(statuses ?? []).map((s) => {
          const st = rowState[s.customer] ?? { uploading: false, error: null };
          const uploaded = s.punchCount > 0;
          const lastError = st.error ?? s.lastError ?? null;
          const showError = !!lastError && (st.error || !uploaded);
          // `lastSkippedAt` is non-null only when the most recent attempt
          // for this (week, customer) short-circuited via the same-hash
          // skip path. A subsequent real attempt (success or error) clears
          // it server-side, so we don't need extra freshness logic here.
          // Suppress the hint when we're actively showing an error to
          // avoid two competing statuses on the same row.
          const showSkipped = !!s.lastSkippedAt && !showError;
          // Every row accepts every supported extension — the server
          // routes by the explicit customer field + content rather than
          // filename, falling back to AI extraction whenever the
          // deterministic parser can't handle the file. Keeping this
          // fixed (not derived from s.extensions) is what makes
          // "upload any format on any row" actually work in the picker.
          const accept = UNIVERSAL_ACCEPT;
          const isRowDragTarget = rowDragCustomer === s.customer;
          return (
            <li
              key={s.customer}
              data-testid={`customer-upload-row-${s.customer}`}
              className={`relative px-4 py-2.5 flex items-center gap-3 hover:bg-muted/20 transition-colors ${
                isRowDragTarget
                  ? "bg-primary/10 ring-2 ring-primary ring-inset"
                  : ""
              }`}
              onDragEnter={(e) => handleRowDragEnter(s.customer, e)}
              onDragOver={handleRowDragOver}
              onDragLeave={(e) => handleRowDragLeave(s.customer, e)}
              onDrop={(e) => handleRowDrop(s.customer, e)}
            >
              {isRowDragTarget && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/5">
                  <div className="rounded border-2 border-dashed border-primary bg-background/95 px-3 py-1.5 shadow text-xs font-display font-semibold flex items-center gap-2">
                    <UploadCloud className="h-4 w-4 text-primary" />
                    {t("customerUpload.dropToUploadAs", { customer: s.customer })}
                  </div>
                </div>
              )}
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
                      {t("customerUpload.punches", { count: s.punchCount })}
                    </Badge>
                  ) : showError ? (
                    <Badge
                      variant="destructive"
                      className="text-[10px]"
                    >
                      {t("customerUpload.lastUploadFailed")}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground"
                    >
                      {t("customerUpload.notUploaded")}
                    </Badge>
                  )}
                  {showSkipped && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground gap-1 border-muted-foreground/30"
                      title={t("customerUpload.latestFileImportedTitle")}
                      data-testid={`badge-skipped-${s.customer}`}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      {t("customerUpload.latestFileImported")}
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
                          title={t("customerUpload.aiBadgeTitle", {
                            aliases: s.aliasCount,
                          })}
                        >
                          <Wand2 className="h-3 w-3" />
                          {t("customerUpload.aiBadge", { count: s.aiImportWeekCount })}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400 gap-1"
                        title={t("customerUpload.aiBadgeTitleNoAdmin", {
                          aliases: s.aliasCount,
                        })}
                      >
                        <Wand2 className="h-3 w-3" />
                        {t("customerUpload.aiBadge", { count: s.aiImportWeekCount })}
                      </Badge>
                    ))}
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {t("customerUpload.anyFile")}
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
                    <span className="italic">{t("customerUpload.noUploadYet")}</span>
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
                      {t("customerUpload.unknownBadges", { count: s.lastUnmappedIds.length })}:{" "}
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
                        ? t("customerUpload.mapIdsAdmin")
                        : t("customerUpload.mapIdsUser")}
                    </span>
                  </div>
                )}
              </div>
              <input
                type="file"
                ref={(el) => {
                  inputs.current[s.customer] = el;
                }}
                data-testid={`customer-upload-input-${s.customer}`}
                accept={accept}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void extractFor(s.customer, f);
                  e.target.value = "";
                }}
              />
              {st.uploading && st.uploadStartedAt != null && (() => {
                const elapsed = Math.max(
                  0,
                  Math.floor((Date.now() - st.uploadStartedAt) / 1000),
                );
                // Past 15s we're almost certainly in the AI fallback path.
                // Tell the dispatcher this is expected on a first-time
                // upload of a new layout, and that the next one will be
                // fast (cache → readWithRoles). Task #255.
                const hint =
                  elapsed > 15
                    ? t("customerUpload.readingHint")
                    : null;
                // Task #296: when the chunked AI extract has published
                // at least one tick, prefer "Chunk N of M" over a bare
                // elapsed counter — it gives the dispatcher a real
                // sense of how close the 71-chunk Adient upload is to
                // done.
                const cp = st.chunkProgress;
                return (
                  <span
                    className="text-xs text-muted-foreground font-mono tabular-nums whitespace-nowrap"
                    aria-live="polite"
                    data-testid={`upload-elapsed-${s.customer}`}
                    title={hint ?? undefined}
                  >
                    {t("customerUpload.reading", { elapsed })}
                    {cp && cp.total > 1 ? (
                      <span
                        className="ml-2 font-sans normal-case text-[11px] text-muted-foreground"
                        data-testid={`upload-chunk-${s.customer}`}
                      >
                        {t("customerUpload.readingChunk", {
                          current: cp.current,
                          total: cp.total,
                        })}
                      </span>
                    ) : null}
                    {hint ? (
                      <span className="ml-2 hidden lg:inline font-sans normal-case text-[10px] text-muted-foreground/80">
                        {hint}
                      </span>
                    ) : null}
                  </span>
                );
              })()}
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
                {uploaded
                  ? t("customerUpload.reuploadButton")
                  : t("customerUpload.uploadButton")}
              </Button>
              {st.uploading && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cancelRowUpload(s.customer)}
                  data-testid={`upload-cancel-${s.customer}`}
                  title={t("customerUpload.cancelUpload")}
                >
                  {t("common.cancel")}
                </Button>
              )}
              {me?.isAdmin && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 shrink-0"
                      title={t("customerUpload.rowActionsTitle", { customer: s.customer })}
                      data-testid={`row-actions-${s.customer}`}
                      disabled={
                        markInactiveMutation.isPending &&
                        markInactiveMutation.variables?.data.customer ===
                          s.customer
                      }
                    >
                      {markInactiveMutation.isPending &&
                      markInactiveMutation.variables?.data.customer ===
                        s.customer ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <span aria-hidden className="text-base leading-none">
                          ⋯
                        </span>
                      )}
                      <span className="sr-only">{t("customerUpload.rowActions")}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel className="text-xs">
                      {s.customer}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => markInactive(s.customer)}
                      className="text-destructive focus:text-destructive"
                    >
                      {t("customerUpload.markInactive")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          );
        })}
      </ul>
      <NewCustomerDialog
        weekStart={weekStart}
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) setNewInitialFile(null);
        }}
        onImported={invalidateAll}
        initialFile={newInitialFile}
      />
      <CustomerPreviewDialog
        preview={preview}
        open={previewOpen}
        onOpenChange={(o) => {
          // Closing the dialog (confirm OR cancel) pops the current
          // preview off the per-week queue. The next pending preview
          // — if extract finished off-screen and queued more than one
          // — takes its place on the following render.
          if (!o) store.popPendingPreview(weekStart);
        }}
        onConfirmed={invalidateAll}
      />
    </Card>
  );
}
