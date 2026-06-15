import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToastAction } from "@/components/ui/toast";
import { Link } from "wouter";
import {
  useGetCustomerUploadStatus,
  useGetMe,
  useGetAllowedTimezones,
  useMarkCustomerInactive,
  getGetCustomerUploadStatusQueryKey,
  getGetWeekSummaryQueryKey,
  getListInactiveCustomersQueryKey,
  getUploadQueueDepth,
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
  FileQuestion,
  FolderUp,
  MessageSquare,
  X,
} from "lucide-react";
import { NewCustomerDialog } from "@/components/new-customer-dialog";
import { CustomerChatDrawer } from "@/components/customer-chat-drawer";
import {
  CustomerPreviewDialog,
  type CustomerPreviewData,
} from "@/components/customer-preview-dialog";
import { UploadAnalysisPill } from "@/components/upload-analysis-pill";

// Task #296: mint a per-upload progress token the server can key the
// in-process progress tracker by. Uses `crypto.randomUUID()` when
// available (modern browsers), falls back to a Math.random + Date.now
// composite for older webviews so the helper never throws — the
// progress badge is observer-only so a weaker uniqueness guarantee is
// acceptable.
function mintProgressKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `pk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Task #296: poll `GET /weeks/:weekStart/extract-progress/:key` once
// every 1 second while an upload is in flight. The endpoint returns
// `{ status: "running", current, total }` once the chunker has
// published its first tick and 204 when the key is unknown (key not
// seen yet, single-call / cache-hit path that never publishes, or
// already cleared). Returns a stop function the caller invokes from
// `finally`. Polling errors are swallowed — this is a UX nicety, not
// a correctness signal.
//
// Task #369: the endpoint may also return
// `{ status: "succeeded" | "failed", httpStatus, result }` once the
// extract is truly done (the result lives on past `clearExtractProgress`
// with a 10-minute TTL). The progress poller here ignores those —
// `waitForExtractResult` below handles them.
function startProgressPolling(
  weekStart: string,
  progressKey: string,
  onTick: (snap: { current: number; total: number }) => void,
): () => void {
  let stopped = false;
  const url = `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-progress/${progressKey}`;
  const tickOnce = async () => {
    if (stopped) return;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (stopped) return;
      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as
          | { current?: number; total?: number }
          | null;
        if (
          body &&
          typeof body.current === "number" &&
          typeof body.total === "number"
        ) {
          onTick({ current: body.current, total: body.total });
        }
      }
    } catch {
      /* observer-only */
    }
  };
  const id = window.setInterval(tickOnce, 1000);
  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}

// Task #369: when the Replit proxy's 5-minute response cap kills an
// extract POST mid-flight, the server-side handler keeps running and
// eventually stashes its terminal `res.json(...)` body into the
// progress tracker. This poll loop waits for that stashed result.
// Resolves with the captured `{ httpStatus, body }` when the server
// publishes one; rejects on `signal.aborted` or after `timeoutMs`.
// Polls every 2 seconds — the extract is already done, we're just
// fetching its persisted result so a longer interval is fine.
//
// `signal` lets the caller bail (e.g. the dispatcher clicks Cancel
// after the proxy abort, or another upload supersedes this one).
export interface ExtractStashedResult {
  status: "succeeded" | "failed";
  httpStatus: number;
  body: Record<string, unknown>;
}
async function waitForExtractResult(
  weekStart: string,
  progressKey: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExtractStashedResult> {
  const url = `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-progress/${progressKey}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
  // Initial 1s grace so the server has a moment to flush its captured
  // result after the socket died.
  await new Promise((r) => window.setTimeout(r, 1000));
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    try {
      const res = await fetch(url, {
        credentials: "include",
        signal: opts.signal,
      });
      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as
          | {
              status?: "running" | "succeeded" | "failed";
              httpStatus?: number;
              result?: Record<string, unknown>;
            }
          | null;
        if (
          body &&
          (body.status === "succeeded" || body.status === "failed") &&
          typeof body.httpStatus === "number" &&
          body.result
        ) {
          return {
            status: body.status,
            httpStatus: body.httpStatus,
            body: body.result,
          };
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      /* network blip — keep polling */
    }
    await new Promise((r) => window.setTimeout(r, 2000));
  }
  throw new Error("extract-result-timeout");
}

// Task #369: sessionStorage key shape for in-flight extract recovery
// across a browser reload. Stored once the POST is in flight; cleared
// on any terminal outcome (success, error, cancel). On panel mount we
// scan for entries matching the current week and reattach via
// `waitForExtractResult`. We intentionally do NOT persist the file
// bytes — the server-side extract is already running; we just need
// to pick up its eventual result.
const REATTACH_STORAGE_PREFIX = "kfi-ot:extract-in-flight:";
interface ReattachEntry {
  weekStart: string;
  customer: string;
  progressKey: string;
  fileName: string;
  startedAt: number;
}
function reattachKey(weekStart: string, customer: string): string {
  return `${REATTACH_STORAGE_PREFIX}${weekStart}::${customer}`;
}
function rememberInFlightExtract(entry: ReattachEntry): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      reattachKey(entry.weekStart, entry.customer),
      JSON.stringify(entry),
    );
  } catch {
    /* sessionStorage may be unavailable (privacy mode) — non-fatal */
  }
}
function forgetInFlightExtract(weekStart: string, customer: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(reattachKey(weekStart, customer));
  } catch {
    /* ignore */
  }
}
function listInFlightExtractsForWeek(weekStart: string): ReattachEntry[] {
  if (typeof window === "undefined") return [];
  const out: ReattachEntry[] = [];
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (!k || !k.startsWith(REATTACH_STORAGE_PREFIX)) continue;
      const raw = window.sessionStorage.getItem(k);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as ReattachEntry;
        if (parsed && parsed.weekStart === weekStart && parsed.progressKey) {
          out.push(parsed);
        }
      } catch {
        /* corrupt entry — drop it */
        window.sessionStorage.removeItem(k);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

// Single source of truth for the file extensions any customer row will
// accept in its `<input accept=...>` and in the bulk dropzone. Every
// row accepts every supported extension; the server routes by the
// explicit customer field + content rather than filename and falls
// through to AI extraction when the deterministic parser can't handle
// the file. Keep this in sync with `isAcceptedUpload` below.
const UNIVERSAL_ACCEPT =
  ".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,.heic,.heif,.webp";

// Temporarily hidden until end-to-end verification is complete. Flip to `true`
// to restore the "Upload all customer files", "Folder…", and
// "New customer file…" buttons in the customer-files panel header.
const SHOW_BULK_UPLOAD_BUTTONS = false;

// Failure-badge staleness thresholds. A failed upload-attempt's badge
// renders loud-red for the first 10 minutes, mutes to a neutral
// "Failed Xm ago" tag between 10 minutes and 24 hours, and is hidden
// entirely past 24 hours (the row falls back to "Not uploaded"). Keeps
// dispatchers from misreading hours-old failures as live regressions
// when they refresh the panel after the underlying issue has been fixed.
const FAILURE_FRESH_MS = 10 * 60 * 1000;
const FAILURE_EXPIRE_MS = 24 * 60 * 60 * 1000;

// Translate raw server errors into copy a payroll dispatcher can act
// on. Most AI-extract failures bubble up the underlying Gemini message
// (e.g. truncated JSON, "model did not return valid JSON", or a column
// position) which is noise to the operator. Keep the original around
// in the server logs; surface this in the toast instead.
function friendlyUploadError(
  raw: string,
  t: (key: string) => string,
): string {
  const lower = raw.toLowerCase();
  if (lower.includes("upload canceled") || lower.includes("aborted")) {
    return t("customerUpload.uploadCanceled");
  }
  if (
    lower.includes("ai extraction timed out") ||
    lower.includes("timed out after")
  ) {
    return t("customerUpload.errorAiTimeout");
  }
  // The new server-side "0 punches" message already explains exactly what
  // happened (unrecognized drivers, out-of-window dates, etc.) and points
  // the dispatcher at Admin → Driver ID aliases. Pass it through verbatim
  // — rewriting it would lose the actionable diagnostics.
  if (lower.includes("parsed 0 punches")) return raw;
  // Task #356: `IngestionBudgetExceeded` errors carry the limit + current
  // call count and direct admins to either split the file or raise the
  // cap. The "Retry with higher limit" button on the row reads off the
  // same regex, so dropping this into the generic AI-extract bucket
  // would both hide the actionable counts and contradict the button.
  if (/per-file safety limit of \d+ model calls/i.test(lower)) return raw;
  if (
    lower.includes("model did not return valid json") ||
    lower.includes("truncated") ||
    lower.includes("salvage")
  ) {
    return t("customerUpload.errorAiInvalidJson");
  }
  if (
    lower.includes("did not return") ||
    lower.includes("ai extract") ||
    lower.includes("gemini") ||
    lower.includes("column") ||
    lower.includes("position")
  ) {
    return t("customerUpload.errorAiGeneric");
  }
  return raw;
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

// Task #408: build the pre-composed first chat message for the
// "Ask Claude" affordances. Keeps the wording out of the JSX and
// gives us one place to tune the prompts later. All copy is plain
// English (matches the rest of the chat drawer surface, which is
// not translated yet).
function buildPreviewChatDraft(preview: CustomerPreviewData): string {
  const lines: string[] = [
    `I just uploaded \`${preview.fileName}\` for ${preview.customer} (week of ${preview.weekStart}) and the preview doesn't look right.`,
  ];
  lines.push(
    `The extractor pulled ${preview.rows.length} row${preview.rows.length === 1 ? "" : "s"}.`,
  );
  if (preview.extractionTruncated) {
    const failed = preview.failedChunks ?? 0;
    lines.push(
      failed > 0
        ? `The AI response was truncated and ${failed} chunk${failed === 1 ? "" : "s"} failed — I think rows are missing.`
        : "The AI response was truncated — I think rows are missing.",
    );
  }
  if (preview.geminiFallbackUsed) {
    lines.push(
      "It fell back to the Gemini extractor (Claude was unreachable), so the rows may need a second look.",
    );
  }
  if (preview.unmappedIds.length > 0) {
    const sample = preview.unmappedIds
      .slice(0, 5)
      .map((u) => (u.sampleName ? `${u.id} (${u.sampleName})` : u.id))
      .join(", ");
    const more =
      preview.unmappedIds.length > 5
        ? ` and ${preview.unmappedIds.length - 5} more`
        : "";
    lines.push(
      `${preview.unmappedIds.length} driver id${preview.unmappedIds.length === 1 ? "" : "s"} couldn't be mapped to a KFI driver: ${sample}${more}.`,
    );
  }
  if (preview.rows.length === 0) {
    lines.push("Zero rows came through — can you help figure out why?");
  } else {
    lines.push("Can you help figure out what went wrong?");
  }
  return lines.join(" ");
}

function buildErrorChatDraft(
  customer: string,
  weekStart: string,
  fileName: string | null,
  error: string,
): string {
  const fileFrag = fileName ? `\`${fileName}\`` : "the file";
  return `I tried to upload ${fileFrag} for ${customer} (week of ${weekStart}) and it failed with: ${error}. Can you help me figure out what to do?`;
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
  /**
   * When `uploading` is true, the wall-clock ms at which the upload
   * started — used to render an elapsed-seconds counter so the dispatcher
   * isn't staring at a frozen spinner during a 90s AI extract.
   */
  uploadStartedAt: number | null;
  /**
   * Task #296: live "chunk N of M" progress for chunked AI extracts.
   * Populated by polling /extract-progress/:progressKey once a second
   * while an upload is in flight; null when no chunked AI extract is
   * running for this row (cache-hit fast path, single-chunk file,
   * pre-extract, or in-flight bulk).
   */
  chunkProgress: { current: number; total: number } | null;
  /**
   * Task #356: when the last extract aborted with
   * `IngestionBudgetExceeded`, we stash the originating file so the
   * admin "Retry with higher limit" button can re-submit it with
   * `?maxCalls=200`. Cleared on the next successful upload or any
   * non-cap error.
   */
  retryFile: File | null;
  /**
   * Task #356: true when the most recent error on this row was the
   * per-upload AI call-cap. Drives whether the "Retry with higher
   * limit" button renders (admin-only).
   */
  capExceeded: boolean;
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
  const { t } = useTranslation();
  // Task #401: 30s staleTime — the panel is rendered alongside the week
  // summary and on every driver-detail page; the underlying endpoint
  // hadn't changed across those mounts. Upload + re-upload mutations
  // still invalidate this query so the warning row updates immediately.
  const { data: statuses } = useGetCustomerUploadStatus(weekStart, {
    query: {
      staleTime: 30_000,
      queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
    },
  });
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const bulkInputRef = useRef<HTMLInputElement>(null);
  const bulkItemRefs = useRef<Record<number, HTMLLIElement | null>>({});
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [chatCustomer, setChatCustomer] = useState<string | null>(null);
  // Task #408: when the chat drawer is opened from an upload-failure
  // affordance (preview "Ask Claude" button, per-row error link,
  // bulk-item error link), pass a pre-composed first message that
  // names the file and summarizes what went wrong. Cleared when the
  // drawer closes so the next manual open starts with an empty box.
  const [chatInitialDraft, setChatInitialDraft] = useState<string | null>(null);
  const openChatForCustomer = (customer: string, draft?: string | null) => {
    setChatInitialDraft(draft ?? null);
    setChatCustomer(customer);
  };
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

  const setRow = (customer: string, patch: Partial<RowState>) => {
    setRowState((prev) => ({
      ...prev,
      [customer]: {
        ...{
          uploading: false,
          error: null,
          uploadStartedAt: null,
          chunkProgress: null,
          retryFile: null,
          capExceeded: false,
        },
        ...prev[customer],
        ...patch,
      },
    }));
  };

  // One AbortController per in-flight per-row upload. Used by the Cancel
  // button next to the spinner so the dispatcher can bail out of a slow
  // AI extract without waiting the full 90 second server-side timeout.
  const rowAborts = useRef<Record<string, AbortController>>({});
  const cancelRowUpload = (customer: string) => {
    const c = rowAborts.current[customer];
    if (c) {
      c.abort();
      delete rowAborts.current[customer];
    }
    // Reset the row's UI state immediately so the spinner, elapsed-seconds
    // badge, and chunk-progress text disappear the moment the dispatcher
    // clicks Cancel. The in-flight handler's catch/finally blocks won't do
    // this for us — they bail out via the stale-controller guard above
    // (rowAborts.current[customer] !== controller) once we delete the entry.
    setRow(customer, {
      uploading: false,
      error: null,
      uploadStartedAt: null,
      chunkProgress: null,
    });
  };

  // 1Hz tick to drive the elapsed-seconds badge while any row is
  // uploading. Cheap — the badge only shows for rows whose
  // `uploadStartedAt` is set, and the interval auto-clears when none are.
  const [, setTick] = useState(0);
  const anyUploading = Object.values(rowState).some((r) => r.uploading);
  useEffect(() => {
    if (!anyUploading) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [anyUploading]);
  // Once-per-minute tick so the "Failed Xm ago" relative timestamps on
  // stale-failure badges stay current without forcing the whole panel to
  // re-render every second. Only runs when at least one customer row has
  // a recent enough failure to be worth refreshing (within the 24h
  // expire window) — beyond that the badge is hidden anyway.
  const hasRecentFailure = (statuses ?? []).some((s) => {
    if (!s.lastError) return false;
    if (!s.lastAttemptAt) return false;
    return Date.now() - new Date(s.lastAttemptAt).getTime() < FAILURE_EXPIRE_MS;
  });
  useEffect(() => {
    if (!hasRecentFailure) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [hasRecentFailure]);

  const formatFailedAgo = (ageMs: number): string => {
    const mins = Math.max(1, Math.floor(ageMs / 60000));
    if (mins < 60) return t("customerUpload.failedAgoMin", { count: mins });
    const hours = Math.max(1, Math.floor(mins / 60));
    return t("customerUpload.failedAgoHour", { count: hours });
  };

  // Task #411: peek at the server's xlsx/AI-extract worker pool right
  // before submitting an upload. We warn whenever the new upload will
  // queue — either because there's already a backlog (`queued > 0`)
  // OR because every worker is already busy (`inflight >= workers`),
  // which is the original motivating case from the task description
  // (2 workers busy + a 3rd upload → no existing queue yet, but the
  // 3rd will queue the moment we POST). The toast is non-blocking and
  // the call is awaited so the warning lands before the spinner
  // starts; failures are swallowed since this is purely advisory.
  const warnIfBusy = async () => {
    try {
      const stats = await getUploadQueueDepth();
      if (stats.disabled) return;
      const willQueue =
        stats.queued > 0 ||
        (stats.workers > 0 && stats.inflight >= stats.workers);
      if (!willQueue) return;
      // "Other uploads" = everything already in flight (queued ones
      // are also waiting on a worker). When `inflight === 0` and we
      // somehow still hit `willQueue` (shouldn't, but guard anyway)
      // fall back to 1 so the message reads naturally.
      const count = Math.max(1, stats.inflight);
      toast({
        title: t("customerUpload.serverBusyTitle"),
        description: t("customerUpload.serverBusyDesc", { count }),
      });
    } catch {
      /* advisory — ignore failures */
    }
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
    opts?: { force?: boolean; explicitCustomer?: boolean; signal?: AbortSignal },
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
    // Task #296: mint a per-upload progress token and start polling
    // /extract-progress so the row badge reads "Chunk N of M" while
    // the chunked AI extract runs. Cleaned up in `finally`.
    const progressKey = mintProgressKey();
    formData.append("progressKey", progressKey);
    const stopPolling = startProgressPolling(weekStart, progressKey, (snap) =>
      setRow(customer, { chunkProgress: snap }),
    );
    rememberInFlightExtract({
      weekStart,
      customer,
      progressKey,
      fileName: file.name,
      startedAt: Date.now(),
    });
    try {
      const qs = opts?.force ? "?force=1" : "";
      let extractStatus = 0;
      let extractBody:
        | (CustomerPreviewData & { skipped?: boolean; error?: string })
        | { error?: string }
        | null = null;
      try {
        const extractRes = await fetch(
          `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-customer-file${qs}`,
          {
            method: "POST",
            credentials: "include",
            body: formData,
            signal: opts?.signal,
          },
        );
        extractStatus = extractRes.status;
        extractBody = (await extractRes.json().catch(() => null)) as
          | (CustomerPreviewData & { skipped?: boolean; error?: string })
          | { error?: string }
          | null;
      } catch (err) {
        // Task #369: proxy-cap or transient network kill — fall through
        // to the persisted-result poll. User-initiated abort is
        // rethrown so the outer catch surfaces "canceled".
        const userAborted =
          opts?.signal?.aborted ||
          (err instanceof DOMException && err.name === "AbortError");
        if (userAborted) throw err;
        const stashed = await waitForExtractResult(weekStart, progressKey, {
          signal: opts?.signal,
        });
        extractStatus = stashed.httpStatus;
        extractBody = stashed.body as typeof extractBody;
      }
      if (extractStatus < 200 || extractStatus >= 300) {
        const msg =
          (extractBody && "error" in extractBody && extractBody.error) ||
          t("customerUpload.uploadFailedFallback");
        return { ok: false, error: msg };
      }
      const preview = extractBody as CustomerPreviewData & {
        skipped?: boolean;
      };
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
            // Mirror the same dispTz override we sent to /extract — the
            // /confirm route is what actually writes `disp_tz` onto every
            // persisted row, so without this the picker would silently
            // fall back to the per-driver default at commit time.
            ...(overrideTz !== "__auto__" ? { dispTz: overrideTz } : {}),
          }),
          signal: opts?.signal,
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
        return {
          ok: false,
          error: confirmBody?.error ?? t("customerUpload.uploadFailedFallback"),
        };
      }
      return {
        ok: true,
        punches: confirmBody?.punchesUpserted ?? 0,
        unmapped: confirmBody?.unmappedIds ?? [],
        skipped: false,
      };
    } catch (err) {
      return { ok: false, error: errMessage(err, t("customerUpload.uploadFailedFallback")) };
    } finally {
      stopPolling();
      forgetInFlightExtract(weekStart, customer);
      setRow(customer, { chunkProgress: null });
    }
  };

  // Two-step flow used by per-row single-file uploads: extract (preview only)
  // → dispatcher confirms in dialog → /confirm-customer-file commits.
  // Cancel = no DB writes.
  //
  // `force` should always be true for user-initiated uploads — the
  // server's same-bytes skip otherwise returns `{ skipped: true }`,
  // suppresses the preview dialog, and surfaces a confusing
  // "already imported" toast even when the dispatcher explicitly
  // wants to replace the existing rows. Every UI caller passes
  // `force: true`; the option stays here so server contracts and
  // direct callers can still opt out.
  //
  // `maxCalls` is the admin one-shot "Retry with higher limit" override
  // from Task #356; the server validates + clamps it to BACKSTOP=200.
  const extractFor = async (
    customer: string,
    file: File,
    opts?: { force?: boolean; maxCalls?: number },
  ) => {
    await warnIfBusy();
    cancelRowUpload(customer);
    const controller = new AbortController();
    rowAborts.current[customer] = controller;
    setRow(customer, {
      uploading: true,
      error: null,
      uploadStartedAt: Date.now(),
      retryFile: null,
      capExceeded: false,
    });
    const formData = new FormData();
    formData.append("file", file);
    // Tell the server which customer the dispatcher aimed at. The server
    // uses this to route by content rather than filename so xlsx, pdf,
    // csv, and image uploads all work on any row regardless of extension.
    formData.append("customer", customer);
    // Task #296: see doUpload — same progress-polling wiring for the
    // two-step preview flow.
    const progressKey = mintProgressKey();
    formData.append("progressKey", progressKey);
    const stopPolling = startProgressPolling(weekStart, progressKey, (snap) =>
      setRow(customer, { chunkProgress: snap }),
    );
    rememberInFlightExtract({
      weekStart,
      customer,
      progressKey,
      fileName: file.name,
      startedAt: Date.now(),
    });
    try {
      // `force` (Task #358) bypasses the server's same-bytes skip on a
      // per-row Re-upload so identical bytes still produce a preview.
      // `maxCalls` (Task #356) is the admin one-shot "Retry with higher
      // limit" override; server-validated + clamped to BACKSTOP=200.
      const params = new URLSearchParams();
      if (opts?.force) params.set("force", "1");
      if (opts?.maxCalls != null) params.set("maxCalls", String(opts.maxCalls));
      const qs = params.toString() ? `?${params.toString()}` : "";
      let resStatus = 0;
      let body:
        | (CustomerPreviewData & { error?: string })
        | { error?: string }
        | null = null;
      try {
        const res = await fetch(
          `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-customer-file${qs}`,
          {
            method: "POST",
            credentials: "include",
            body: formData,
            signal: controller.signal,
          },
        );
        resStatus = res.status;
        body = (await res.json().catch(() => null)) as typeof body;
      } catch (err) {
        // Task #369: the Replit proxy caps proxied responses at 5
        // minutes, so a long AI extract can have its POST socket
        // killed mid-flight even though the server-side handler runs
        // to completion. Recover by polling the result-stash endpoint
        // for the persisted terminal response — but only if the
        // dispatcher didn't explicitly cancel.
        const userAborted =
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError");
        if (userAborted) throw err;
        const stashed = await waitForExtractResult(weekStart, progressKey, {
          signal: controller.signal,
        });
        resStatus = stashed.httpStatus;
        body = stashed.body as typeof body;
      }
      if (resStatus < 200 || resStatus >= 300) {
        throw new Error(
          (body && "error" in body && body.error) ||
            t("customerUpload.uploadFailedFallback"),
        );
      }
      const data = body as CustomerPreviewData & { skipped?: boolean };
      // Guard against a stale response clobbering a newer upload on the
      // same row: if the dispatcher canceled or kicked off another
      // upload while this one was in flight, drop the result on the
      // floor instead of opening the preview / clearing the spinner.
      if (rowAborts.current[customer] !== controller) return;
      setRow(customer, {
        uploading: false,
        error: null,
        uploadStartedAt: null,
      });
      // Task #381: the server short-circuits identical re-uploads with
      // `{ skipped: true, sampleId: null, rows: [] }`. The bulk path
      // already handles this, but per-row uploads used to open a 0-row
      // preview dialog (and fire a follow-up DELETE /…/null) when the
      // dispatcher dropped the same file twice. Surface a neutral toast
      // and leave the prior import in place instead.
      if (data.skipped) {
        toast({
          title: t("customerUpload.alreadyImportedTitle", { customer }),
          description: t("customerUpload.alreadyImportedDesc"),
        });
        return;
      }
      setPreview(data);
      setPreviewOpen(true);
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError");
      // Same stale-request guard for the error path — a newer upload
      // already owns this row's state.
      if (rowAborts.current[customer] !== controller && !aborted) return;
      const raw = aborted
        ? t("customerUpload.uploadCanceled")
        : errMessage(err, t("customerUpload.uploadFailedFallback"));
      const msg = friendlyUploadError(raw, t);
      // Task #356: detect `IngestionBudgetExceeded` so the row can
      // surface an admin-only "Retry with higher limit" button. The
      // raw server message looks like:
      //   "AI extraction stopped: this upload would exceed the per-file
      //    safety limit of N model calls (currently M). ..."
      const capExceeded =
        !aborted && /per-file safety limit of \d+ model calls/i.test(raw);
      if (rowAborts.current[customer] === controller) {
        setRow(customer, {
          uploading: false,
          error: aborted ? null : msg,
          uploadStartedAt: null,
          retryFile: capExceeded ? file : null,
          capExceeded,
        });
      }
      if (!aborted) {
        toast({
          title: t("customerUpload.extractFailedTitle", { customer }),
          description: msg,
          variant: "destructive",
          action: (
            <ToastAction
              altText={`Ask Claude about ${file.name}`}
              onClick={() =>
                openChatForCustomer(
                  customer,
                  buildErrorChatDraft(customer, weekStart, file.name, msg),
                )
              }
            >
              Ask Claude
            </ToastAction>
          ),
        });
      }
    } finally {
      if (rowAborts.current[customer] === controller) {
        delete rowAborts.current[customer];
      }
      stopPolling();
      forgetInFlightExtract(weekStart, customer);
      setRow(customer, { chunkProgress: null });
    }
  };

  // Task #369: reattach to any extract that was in flight when the
  // panel last unmounted (browser reload, navigation back, etc.).
  // We persisted the progressKey to sessionStorage at POST time;
  // here we poll the result-stash endpoint and pick up where we
  // left off. Best-effort — if the server already TTL'd the result
  // (10 minutes), the row clears and the dispatcher just re-uploads.
  useEffect(() => {
    const pending = listInFlightExtractsForWeek(weekStart);
    if (pending.length === 0) return;
    const controllers: AbortController[] = [];
    for (const entry of pending) {
      // Skip rows that already have a fresh in-flight upload — the
      // active POST owns the row and will clean sessionStorage in
      // its own finally block.
      if (rowAborts.current[entry.customer]) continue;
      const controller = new AbortController();
      controllers.push(controller);
      rowAborts.current[entry.customer] = controller;
      setRow(entry.customer, {
        uploading: true,
        error: null,
        uploadStartedAt: entry.startedAt,
      });
      void (async () => {
        try {
          const stashed = await waitForExtractResult(
            weekStart,
            entry.progressKey,
            { signal: controller.signal },
          );
          if (rowAborts.current[entry.customer] !== controller) return;
          if (stashed.status === "succeeded") {
            const data = stashed.body as unknown as CustomerPreviewData;
            setRow(entry.customer, {
              uploading: false,
              error: null,
              uploadStartedAt: null,
            });
            setPreview(data);
            setPreviewOpen(true);
          } else {
            const errRaw =
              (stashed.body as { error?: string })?.error ??
              t("customerUpload.uploadFailedFallback");
            const msg = friendlyUploadError(errRaw, t);
            setRow(entry.customer, {
              uploading: false,
              error: msg,
              uploadStartedAt: null,
            });
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
          if (rowAborts.current[entry.customer] !== controller) return;
          setRow(entry.customer, {
            uploading: false,
            error: t("customerUpload.uploadFailedFallback"),
            uploadStartedAt: null,
          });
        } finally {
          if (rowAborts.current[entry.customer] === controller) {
            delete rowAborts.current[entry.customer];
          }
          forgetInFlightExtract(weekStart, entry.customer);
        }
      })();
    }
    return () => {
      for (const c of controllers) c.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

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

  // Per-week single-flight AbortController for the bulk loop. Used by the
  // Stop button rendered in the bulk-results header while `bulkRunning`
  // is true. Wiring the signal into `doUpload` aborts the in-flight
  // /extract or /confirm fetch; the post-await check below the loop breaks
  // out of the queue so any remaining pending items stay in `"pending"`
  // status instead of marching on. Covered by
  // `e2e/bulk-upload-cancel.spec.ts` (#385).
  const bulkAbortRef = useRef<AbortController | null>(null);
  const cancelBulk = () => {
    const c = bulkAbortRef.current;
    if (c) c.abort();
  };

  const runBulk = async (files: File[]) => {
    if (files.length === 0) return;
    await warnIfBusy();
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
    const bulkAbort = new AbortController();
    bulkAbortRef.current = bulkAbort;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let needsReview = 0;
    let firstFailedIdx: number | null = null;
    for (let i = 0; i < initial.length; i++) {
      if (bulkAbort.signal.aborted) break;
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
      // Always force in bulk too — dispatchers re-drop a whole folder
      // to replace whatever's in the week, and the "skipped: already
      // imported" branch silently leaves stale rows in place, which
      // looks like the upload was ignored.
      // `explicitCustomer` ensures the server routes by content, so files
      // whose extension doesn't match the deterministic parser
      // (e.g. an IWG CSV, a DeLallo image) still land on the right
      // customer instead of getting mis-routed or rejected.
      const r = await doUpload(customer, item.file, {
        explicitCustomer: true,
        force: true,
        signal: bulkAbort.signal,
      });
      if (bulkAbort.signal.aborted) {
        // Roll the current row back to pending so the dispatcher sees a
        // clean "didn't run" state for it and every item after it (the
        // post-await abort window happens after `setRow(uploading)` and
        // after the awaited `doUpload` resolves with an error from the
        // aborted fetch).
        setBulkItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "pending" } : it,
          ),
        );
        setRow(customer, { uploading: false, error: null });
        break;
      }
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
        const msg = friendlyUploadError(r.error, t);
        setBulkItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "error", error: msg } : it,
          ),
        );
        setRow(customer, { uploading: false, error: msg });
      }
    }
    const aborted = bulkAbort.signal.aborted;
    bulkAbortRef.current = null;
    setBulkRunning(false);
    invalidateAll();
    if (aborted) {
      toast({
        title: t("customerUpload.bulkCanceledTitle"),
        description: t("customerUpload.bulkCanceledDesc", {
          uploaded,
          remaining: initial.length - uploaded - skipped - failed - needsReview,
        }),
      });
      return;
    }
    const parts = [t("customerUpload.bulkUploaded", { count: uploaded })];
    if (skipped > 0) parts.push(t("customerUpload.bulkSkipped", { count: skipped }));
    if (needsReview > 0)
      parts.push(t("customerUpload.bulkNeedReview", { count: needsReview }));
    parts.push(t("customerUpload.bulkFailed", { count: failed }));
    toast({
      title: t("customerUpload.bulkCompleteTitle"),
      description: parts.join(", ") + ".",
      variant: failed > 0 ? "destructive" : "default",
      action:
        firstFailedIdx != null
          ? (
              <ToastAction
                altText={t("customerUpload.showFirstFailureAlt")}
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
                {t("customerUpload.showFirstFailure")}
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
    //
    // Always force on user-initiated row uploads so identical bytes still
    // produce a preview the dispatcher can confirm-to-replace, instead of
    // the server short-circuiting with `{ skipped: true }` and a confusing
    // "already imported" toast.
    void extractFor(customer, file, { force: true });
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
          {SHOW_BULK_UPLOAD_BUTTONS && (
            <>
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
            </>
          )}
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
            {bulkRunning ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={cancelBulk}
                data-testid="button-cancel-bulk"
              >
                <X className="h-3 w-3 mr-1" />
                {t("customerUpload.cancelBulk")}
              </Button>
            ) : (
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
                        className="mt-1 text-destructive text-[11px] font-medium leading-snug flex flex-wrap items-center gap-1"
                        data-testid={`bulk-item-error-${idx}`}
                      >
                        <span>
                          {item.error ?? t("customerUpload.uploadFailedFallback")}
                        </span>
                        {item.customer && (
                          <button
                            type="button"
                            className="ml-1 inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:no-underline text-foreground"
                            data-testid={`bulk-item-ask-claude-${idx}`}
                            onClick={() => {
                              if (!item.customer) return;
                              openChatForCustomer(
                                item.customer,
                                buildErrorChatDraft(
                                  item.customer,
                                  weekStart,
                                  item.file.name,
                                  item.error ??
                                    t("customerUpload.uploadFailedFallback"),
                                ),
                              );
                            }}
                          >
                            <MessageSquare className="h-3 w-3" />
                            Ask Claude
                          </button>
                        )}
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
          const st = rowState[s.customer] ?? {
            uploading: false,
            error: null,
            uploadStartedAt: null,
            chunkProgress: null,
            retryFile: null,
            capExceeded: false,
          };
          const uploaded = s.punchCount > 0;
          // Compute failure age from the persisted attempt timestamp so an
          // hours-old failure renders as a muted "Failed Xm ago" tag (or
          // disappears entirely past 24h) instead of a loud red badge that
          // dispatchers misread as a live regression on page refresh. A
          // freshly-thrown local error (`st.error`) is always treated as
          // live regardless of the persisted timestamp.
          const persistedFailureAge =
            s.lastError && s.lastAttemptAt
              ? Date.now() - new Date(s.lastAttemptAt).getTime()
              : null;
          const isExpiredFailure =
            !st.error &&
            persistedFailureAge !== null &&
            persistedFailureAge >= FAILURE_EXPIRE_MS;
          const isStaleFailure =
            !st.error &&
            persistedFailureAge !== null &&
            persistedFailureAge >= FAILURE_FRESH_MS &&
            persistedFailureAge < FAILURE_EXPIRE_MS;
          const lastError = isExpiredFailure
            ? null
            : (st.error ?? s.lastError ?? null);
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
                  <AlertCircle
                    className={`h-4 w-4 ${
                      isStaleFailure
                        ? "text-muted-foreground/60"
                        : "text-destructive"
                    }`}
                  />
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
                    isStaleFailure && persistedFailureAge !== null ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] text-muted-foreground border-muted-foreground/30"
                        title={t("customerUpload.staleErrorTitle")}
                        data-testid={`badge-stale-failed-${s.customer}`}
                      >
                        {formatFailedAgo(persistedFailureAge)}
                      </Badge>
                    ) : (
                      <Badge
                        variant="destructive"
                        className="text-[10px]"
                      >
                        {t("customerUpload.lastUploadFailed")}
                      </Badge>
                    )
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
                  {s.hasCachedLayout && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground border-muted-foreground/30"
                      title={t("customerUpload.cachedLayoutBadgeTitle")}
                      data-testid={`badge-cached-layout-${s.customer}`}
                    >
                      {t("customerUpload.cachedLayoutBadge")}
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
                  {s.latestUploadAnalysis && (
                    <UploadAnalysisPill
                      weekStart={weekStart}
                      customer={s.customer}
                      summary={s.latestUploadAnalysis}
                    />
                  )}
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
                  <div
                    className={`mt-1 text-xs flex items-start gap-1 flex-wrap ${
                      isStaleFailure
                        ? "text-muted-foreground"
                        : "text-destructive"
                    }`}
                  >
                    <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>{lastError}</span>
                    <button
                      type="button"
                      className="ml-1 inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:no-underline text-foreground"
                      data-testid={`row-ask-claude-${s.customer}`}
                      onClick={() =>
                        openChatForCustomer(
                          s.customer,
                          buildErrorChatDraft(
                            s.customer,
                            weekStart,
                            s.lastFileName ?? null,
                            lastError ?? "",
                          ),
                        )
                      }
                    >
                      <MessageSquare className="h-3 w-3" />
                      Ask Claude
                    </button>
                  </div>
                )}
                {st.capExceeded && st.retryFile && me?.isAdmin && (
                  <div className="mt-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      data-testid={`button-retry-higher-limit-${s.customer}`}
                      onClick={() => {
                        if (st.retryFile) {
                          void extractFor(s.customer, st.retryFile, {
                            force: true,
                            maxCalls: 200,
                          });
                        }
                      }}
                    >
                      {t("customerUpload.retryHigherLimit")}
                    </Button>
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
                data-testid={`customer-upload-input-${s.customer}`}
                ref={(el) => {
                  inputs.current[s.customer] = el;
                }}
                accept={accept}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Always force on user-initiated row uploads so identical
                  // bytes still produce a preview the dispatcher can
                  // confirm-to-replace, instead of the server short-
                  // circuiting with `{ skipped: true }`.
                  if (f) void extractFor(s.customer, f, { force: true });
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
                // done. Task #328: when this upload resumed from
                // staging (a prior attempt got partway through), show
                // "Resumed N of M — re-running K" instead so the long
                // wait makes sense ("we already have most of it,
                // just re-running the chunks that failed").
                const cp = st.chunkProgress;
                const resumed =
                  cp && typeof cp.resumedFromStaging === "number"
                    ? cp.resumedFromStaging
                    : 0;
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
                        {resumed > 0 && resumed < cp.total
                          ? t("customerUpload.readingChunkResumed", {
                              resumed,
                              total: cp.total,
                              remaining: cp.total - resumed,
                            })
                          : t("customerUpload.readingChunk", {
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
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 shrink-0"
                title={`Fix upload with chat · ${s.customer}`}
                data-testid={`customer-chat-open-${s.customer}`}
                onClick={() => setChatCustomer(s.customer)}
              >
                <MessageSquare className="h-4 w-4" />
                <span className="sr-only">Open chat</span>
              </Button>
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
        onOpenChange={setPreviewOpen}
        onConfirmed={invalidateAll}
        onAskClaude={
          preview
            ? () =>
                openChatForCustomer(
                  preview.customer,
                  buildPreviewChatDraft(preview),
                )
            : undefined
        }
      />
      {chatCustomer && (
        <CustomerChatDrawer
          weekStart={weekStart}
          customer={chatCustomer}
          open={chatCustomer !== null}
          onOpenChange={(o) => {
            if (!o) {
              setChatCustomer(null);
              setChatInitialDraft(null);
            }
          }}
          onApplied={invalidateAll}
          initialDraft={chatInitialDraft ?? undefined}
        />
      )}
    </Card>
  );
}
