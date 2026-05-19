import { useRef, useState } from "react";
import { ToastAction } from "@/components/ui/toast";
import { Link } from "wouter";
import {
  useGetCustomerUploadStatus,
  useGetMe,
  useCreateParserPromotionSnooze,
  useGetAllowedTimezones,
  useMarkCustomerInactive,
  getGetCustomerUploadStatusQueryKey,
  getGetWeekSummaryQueryKey,
  getListParserPromotionSnoozesQueryKey,
  getListInactiveCustomersQueryKey,
} from "@workspace/api-client-react";
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
  BellOff,
  FileQuestion,
  FolderUp,
  X,
} from "lucide-react";
import { NewCustomerDialog } from "@/components/new-customer-dialog";
import {
  CustomerPreviewDialog,
  type CustomerPreviewData,
} from "@/components/customer-preview-dialog";

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
function friendlyUploadError(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes("model did not return valid json") ||
    lower.includes("truncated") ||
    lower.includes("salvage")
  ) {
    return "AI couldn't read this file end-to-end. Try uploading the original spreadsheet or a clearer scan, then re-try.";
  }
  if (
    lower.includes("did not return") ||
    lower.includes("ai extract") ||
    lower.includes("gemini") ||
    lower.includes("column") ||
    lower.includes("position")
  ) {
    return "AI couldn't read this file. Try a clearer scan or the original export, then re-try.";
  }
  return raw;
}

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

interface RowState {
  uploading: boolean;
  error: string | null;
}

interface BulkItem {
  file: File;
  customer: string | null;
  status:
    | "pending"
    | "uploading"
    | "success"
    | "warning"
    | "skipped"
    | "error"
    | "unknown";
  punchesUpserted?: number;
  unmappedCount?: number;
  error?: string;
}

interface UnmappedId {
  id: string;
  count: number;
  sampleName: string | null;
}

type UploadResult =
  | { ok: true; punches: number; unmapped: UnmappedId[]; skipped: boolean }
  | { ok: false; error: string };

export function CustomerUploadPanel({ weekStart }: { weekStart: string }) {
  const { data: statuses } = useGetCustomerUploadStatus(weekStart);
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const bulkInputRef = useRef<HTMLInputElement>(null);
  const bulkItemRefs = useRef<Record<number, HTMLLIElement | null>>({});
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [newInitialFile, setNewInitialFile] = useState<File | null>(null);
  const [bulkItems, setBulkItems] = useState<BulkItem[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepth = useRef(0);
  // When the user is dragging over a specific row, suppress the whole-panel
  // overlay so the per-row drop target reads as the active target.
  const [rowDragCustomer, setRowDragCustomer] = useState<string | null>(null);
  const rowDragDepth = useRef<Record<string, number>>({});
  const markInactiveMutation = useMarkCustomerInactive();
  const [preview, setPreview] = useState<CustomerPreviewData | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [overrideTz, setOverrideTz] = useState<string>("__auto__");
  const { data: allowedTzs } = useGetAllowedTimezones();
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

  const markInactive = (customer: string) => {
    markInactiveMutation.mutate(
      { data: { customer } },
      {
        onSuccess: () => {
          toast({
            title: `Hid "${customer}"`,
            description:
              "Existing punches and uploads are kept. Reactivate from Admin · Inactive customers to bring it back.",
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
            title: "Couldn't mark inactive",
            description: errMessage(err, "Mark inactive failed"),
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

  // One-shot upload used by the bulk-upload flow (no per-file preview UX):
  // POST /extract-customer-file then immediately POST /confirm-customer-file
  // with no excludedIndices. The extract route short-circuits on a matching
  // SHA-256 hash and returns `{ skipped: true }`, which bulk renders as
  // "Already up to date" without calling confirm. Per-row single-file
  // uploads go through `extractFor` instead so the dispatcher can review.
  const doUpload = async (
    customer: string,
    file: File,
    opts?: { force?: boolean; explicitCustomer?: boolean },
  ): Promise<UploadResult> => {
    const formData = new FormData();
    formData.append("file", file);
    if (overrideTz !== "__auto__") {
      formData.append("dispTz", overrideTz);
    }
    // When the dispatcher explicitly aimed at this customer (per-row
    // re-upload button), pass the customer so the server can route by
    // content instead of filename — accepting any extension.
    if (opts?.explicitCustomer) {
      formData.append("customer", customer);
    }
    try {
      const qs = opts?.force ? "?force=1" : "";
      const extractRes = await fetch(
        `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-customer-file${qs}`,
        { method: "POST", credentials: "include", body: formData },
      );
      const extractBody = (await extractRes.json().catch(() => null)) as
        | (CustomerPreviewData & { skipped?: boolean; error?: string })
        | { error?: string }
        | null;
      if (!extractRes.ok) {
        const msg =
          (extractBody && "error" in extractBody && extractBody.error) ||
          "Upload failed";
        return { ok: false, error: msg };
      }
      const preview = extractBody as CustomerPreviewData & {
        skipped?: boolean;
      };
      if (preview.customer && preview.customer !== customer) {
        return {
          ok: false,
          error: `File detected as "${preview.customer}" but you uploaded it for "${customer}". Rename the file to include "${customer}" so it routes correctly.`,
        };
      }
      if (preview.skipped) {
        return { ok: true, punches: 0, unmapped: [], skipped: true };
      }
      const confirmRes = await fetch(
        `${import.meta.env.BASE_URL}api/weeks/${weekStart}/confirm-customer-file`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer: preview.customer,
            sampleId: preview.sampleId,
          }),
        },
      );
      const confirmBody = (await confirmRes.json().catch(() => null)) as
        | {
            punchesUpserted?: number;
            unmappedIds?: UnmappedId[];
            error?: string;
          }
        | null;
      if (!confirmRes.ok) {
        return { ok: false, error: confirmBody?.error ?? "Upload failed" };
      }
      return {
        ok: true,
        punches: confirmBody?.punchesUpserted ?? 0,
        unmapped: confirmBody?.unmappedIds ?? [],
        skipped: false,
      };
    } catch (err) {
      return { ok: false, error: errMessage(err, "Upload failed") };
    }
  };

  // Two-step flow used by per-row single-file uploads: extract (preview only)
  // → dispatcher confirms in dialog → /confirm-customer-file commits.
  // Cancel = no DB writes.
  const extractFor = async (customer: string, file: File) => {
    setRow(customer, { uploading: true, error: null });
    const formData = new FormData();
    formData.append("file", file);
    // Tell the server which customer the dispatcher aimed at. The server
    // uses this to route by content rather than filename so xlsx, pdf,
    // csv, and image uploads all work on any row regardless of extension.
    formData.append("customer", customer);
    try {
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-customer-file`,
        { method: "POST", credentials: "include", body: formData },
      );
      const body = (await res.json().catch(() => null)) as
        | (CustomerPreviewData & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(
          (body && "error" in body && body.error) || "Upload failed",
        );
      }
      const data = body as CustomerPreviewData;
      if (data.customer && data.customer !== customer) {
        throw new Error(
          `File detected as "${data.customer}" but you uploaded it for "${customer}". Rename the file to include "${customer}" so it routes correctly.`,
        );
      }
      setRow(customer, { uploading: false, error: null });
      setPreview(data);
      setPreviewOpen(true);
    } catch (err) {
      const raw = errMessage(err, "Upload failed");
      const msg = friendlyUploadError(raw);
      setRow(customer, { uploading: false, error: msg });
      toast({
        title: `${customer} extract failed`,
        description: msg,
        variant: "destructive",
      });
    }
  };

  const uploadFor = async (customer: string, file: File) => {
    setRow(customer, { uploading: true, error: null });
    // Per-row Re-upload always forces — the dispatcher explicitly chose this
    // file, so skipping it as a duplicate would be confusing. Skip detection
    // is for bulk re-runs only.
    const r = await doUpload(customer, file, {
      force: true,
      explicitCustomer: true,
    });
    if (!r.ok) {
      const msg = friendlyUploadError(r.error);
      setRow(customer, { uploading: false, error: msg });
      toast({
        title: `${customer} upload failed`,
        description: msg,
        variant: "destructive",
      });
      return;
    }
    setRow(customer, { uploading: false, error: null });
    if (r.unmapped.length > 0) {
      const formatted = r.unmapped
        .map((u) => (u.sampleName ? `${u.id} (${u.sampleName})` : u.id))
        .join(", ");
      toast({
        title: `${customer} uploaded with ${r.unmapped.length} unknown ${
          r.unmapped.length === 1 ? "badge" : "badges"
        }`,
        description: `Imported ${r.punches} punches. These IDs aren't in the KFI roster, so their rows were skipped: ${formatted}. Add them to the driver mapping if they're new hires.`,
        variant: "destructive",
      });
    } else {
      toast({
        title: `${customer} uploaded`,
        description: `Imported ${r.punches} punches.`,
      });
    }
    invalidateAll();
  };

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
        title: `Skipped ${rejected.length} unsupported ${rejected.length === 1 ? "file" : "files"}`,
        description: `Only .xlsx, .xls, .csv, .pdf, and image files (JPG, PNG, HEIC, WEBP) are accepted. Skipped: ${rejected.join(", ")}.`,
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

  const runBulk = async (files: File[]) => {
    if (files.length === 0) return;
    const initial: BulkItem[] = files.map((file) => {
      const customer = classifyFile(file);
      return {
        file,
        customer,
        status: customer ? "pending" : "unknown",
      };
    });
    setBulkItems(initial);
    setBulkRunning(true);
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let needsReview = 0;
    let firstFailedIdx: number | null = null;
    for (let i = 0; i < initial.length; i++) {
      const item = initial[i];
      if (!item.customer) {
        needsReview++;
        continue;
      }
      const customer = item.customer;
      setBulkItems((prev) =>
        prev.map((it, idx) =>
          idx === i ? { ...it, status: "uploading" } : it,
        ),
      );
      setRow(customer, { uploading: true, error: null });
      // Bulk re-runs intentionally do NOT pass force — that's the whole
      // point of this flow: identical files short-circuit on the server.
      // Bulk classifier already routed by filename keyword; force the
      // server to honor that decision so files whose extension doesn't
      // match the deterministic parser (e.g. an IWG CSV, a DeLallo
      // image) still land on the right customer and fall through to AI
      // instead of getting mis-routed or rejected.
      const r = await doUpload(customer, item.file, {
        explicitCustomer: true,
      });
      if (r.ok) {
        if (r.skipped) {
          skipped++;
        } else {
          uploaded++;
        }
        const warning = !r.skipped && r.unmapped.length > 0;
        setBulkItems((prev) =>
          prev.map((it, idx) =>
            idx === i
              ? {
                  ...it,
                  status: r.skipped
                    ? "skipped"
                    : warning
                      ? "warning"
                      : "success",
                  punchesUpserted: r.punches,
                  unmappedCount: r.unmapped.length,
                }
              : it,
          ),
        );
        setRow(customer, { uploading: false, error: null });
      } else {
        failed++;
        if (firstFailedIdx === null) firstFailedIdx = i;
        const msg = friendlyUploadError(r.error);
        setBulkItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "error", error: msg } : it,
          ),
        );
        setRow(customer, { uploading: false, error: msg });
      }
    }
    setBulkRunning(false);
    invalidateAll();
    const parts = [`${uploaded} uploaded`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (needsReview > 0) parts.push(`${needsReview} need review`);
    parts.push(`${failed} failed`);
    toast({
      title: `Bulk upload complete`,
      description: parts.join(", ") + ".",
      variant: failed > 0 ? "destructive" : "default",
      action:
        firstFailedIdx != null
          ? (
              <ToastAction
                altText="Show first failed file"
                onClick={() => {
                  const el = bulkItemRefs.current[firstFailedIdx];
                  if (!el) return;
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  el.classList.add("ring-2", "ring-destructive");
                  window.setTimeout(() => {
                    el.classList.remove("ring-2", "ring-destructive");
                  }, 2000);
                }}
              >
                Show first failure
              </ToastAction>
            )
          : undefined,
    });
  };

  const openNewWithFile = (file: File | null) => {
    setNewInitialFile(file);
    setNewOpen(true);
  };

  const dismissBulk = () => setBulkItems([]);

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
        title: "Drop a single file per customer",
        description: `Per-row upload accepts one file at a time. Use the panel-wide drop zone to bulk-upload ${files.length} files.`,
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
        title: "Unsupported file type",
        description: `Only .xlsx, .xls, .csv, .pdf, and image files (JPG, PNG, HEIC, WEBP) are accepted. "${file.name}" was skipped.`,
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
        title: "Upload already in progress",
        description: "Wait for the current bulk upload to finish before dropping more files.",
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

  const promotionCandidates = (statuses ?? []).filter(
    (s) => s.promotionCandidate,
  );

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
                Drop customer files to upload
              </div>
              <div className="text-xs text-muted-foreground">
                .xlsx, .pdf, or photos (JPG/PNG/HEIC) — anything else is skipped
              </div>
            </div>
          </div>
        </div>
      )}
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
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Tz
            </span>
            <Select value={overrideTz} onValueChange={setOverrideTz}>
              <SelectTrigger
                className="h-8 w-[170px] text-xs"
                data-testid="select-upload-tz"
                title="Override the timezone applied to the next upload. 'Auto' uses the driver / customer / system default."
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__" className="text-xs">
                  Auto (per driver/customer)
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
            Upload all customer files
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkRunning}
            onClick={() => folderInputRef.current?.click()}
            title="Pick a whole folder; all .xlsx, .pdf, and image files inside are uploaded."
            data-testid="button-upload-folder"
          >
            <FolderUp className="mr-2 h-4 w-4" />
            Folder…
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openNewWithFile(null)}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            New customer file…
          </Button>
        </div>
      </div>
      {bulkItems.length > 0 && (
        <div className="border-b border-border bg-muted/20 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-display font-semibold text-sm">
              {bulkRunning ? "Uploading…" : "Bulk upload results"}
            </h4>
            {!bulkRunning && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={dismissBulk}
              >
                <X className="h-3 w-3 mr-1" />
                Dismiss
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
                          {item.punchesUpserted} punches imported
                        </span>
                      )}
                      {item.status === "warning" && (
                        <span className="text-[10px] text-amber-700 dark:text-amber-400">
                          {item.punchesUpserted} imported · {item.unmappedCount}{" "}
                          unknown{" "}
                          {item.unmappedCount === 1 ? "badge" : "badges"}
                        </span>
                      )}
                      {item.status === "skipped" && (
                        <span className="text-[10px] text-muted-foreground">
                          Already up to date
                        </span>
                      )}
                    </div>
                    {isError && (
                      <div
                        className="mt-1 text-destructive text-[11px] font-medium leading-snug"
                        data-testid={`bulk-item-error-${idx}`}
                      >
                        {item.error ?? "Upload failed"}
                      </div>
                    )}
                    {driftHint && (
                      <div className="mt-1 text-[11px] text-amber-800 dark:text-amber-300 flex items-start gap-1">
                        <Lightbulb className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>
                          Probably a format change — open the file directly and
                          compare it against the last working upload before
                          retrying.
                        </span>
                      </div>
                    )}
                    {isUnknown && (
                      <div className="mt-0.5 text-amber-800 dark:text-amber-300 text-[11px]">
                        Not a known customer — use the new-customer flow to map
                        it.
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
                      New customer file…
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
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
                    Drop to upload as {s.customer}
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
                  {showSkipped && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground gap-1 border-muted-foreground/30"
                      title="Your most recent upload for this customer was identical to the file already imported, so it was skipped. Use Re-upload to force a fresh import anyway."
                      data-testid={`badge-skipped-${s.customer}`}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Latest file already imported
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
                  if (f) void extractFor(s.customer, f);
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
              {me?.isAdmin && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 shrink-0"
                      title={`Row actions for ${s.customer}`}
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
                      <span className="sr-only">Row actions</span>
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
                      Mark inactive (hide from this panel)
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
        onOpenChange={setPreviewOpen}
        onConfirmed={invalidateAll}
      />
    </Card>
  );
}
