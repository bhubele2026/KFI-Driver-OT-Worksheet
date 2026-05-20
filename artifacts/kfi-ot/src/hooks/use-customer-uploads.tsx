import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  getGetCustomerUploadStatusQueryKey,
  getGetWeekSummaryQueryKey,
} from "@workspace/api-client-react";
import { useToast, toast as toastSingleton } from "@/hooks/use-toast";
type ToastFn = typeof toastSingleton;
import i18n from "@/i18n";
import { ToastAction } from "@/components/ui/toast";
import type { CustomerPreviewData } from "@/components/customer-preview-dialog";

// ---------------------------------------------------------------------------
// Types kept identical to the legacy panel so the component changes stay
// small. `RowState` / `BulkItem` / `UnmappedId` mirror the structures the
// panel used to own.
// ---------------------------------------------------------------------------

export interface RowState {
  uploading: boolean;
  error: string | null;
  uploadStartedAt: number | null;
  chunkProgress: {
    current: number;
    total: number;
    resumedFromStaging?: number;
  } | null;
}

export interface BulkItem {
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

export interface UnmappedId {
  id: string;
  count: number;
  sampleName: string | null;
}

export type UploadResult =
  | { ok: true; punches: number; unmapped: UnmappedId[]; skipped: boolean }
  | { ok: false; error: string };

export interface UploadFor {
  customer: string;
  file: File;
  /** Dispatcher's per-upload tz override (`__auto__` means "use roster default"). */
  overrideTz: string;
  /** Filename-classifier hits → routed customer for the bulk path. */
}

interface WeekStateSnapshot {
  rowState: Record<string, RowState>;
  bulkItems: BulkItem[];
  bulkRunning: boolean;
  pendingPreviews: CustomerPreviewData[];
  /** Increments every time the panel calls `dismissBulk` so a follow-up
   * upload from a freshly-mounted panel resets the bulk list correctly. */
  version: number;
}

interface WeekRecord {
  state: WeekStateSnapshot;
  /** Per-row in-flight aborts. Lives outside React state because aborting
   * is imperative and the controllers must survive panel unmount. */
  rowAborts: Map<string, AbortController>;
  /** Per-row chunk-progress poll stoppers. */
  rowPollStops: Map<string, () => void>;
  /** Bulk upload abort controller — single-flight per week. */
  bulkAbort: AbortController | null;
}

const EMPTY_ROW_STATE: RowState = {
  uploading: false,
  error: null,
  uploadStartedAt: null,
  chunkProgress: null,
};

// ---------------------------------------------------------------------------
// Translation helper. We can't use `useTranslation` from outside React, so
// fall back to `i18n.t` directly (returns the current locale's value).
// ---------------------------------------------------------------------------

function tr(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(key, opts) as string;
}

function friendlyUploadError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("upload canceled") || lower.includes("aborted")) {
    return tr("customerUpload.uploadCanceled");
  }
  if (
    lower.includes("ai extraction timed out") ||
    lower.includes("timed out after")
  ) {
    return tr("customerUpload.errorAiTimeout");
  }
  if (lower.includes("parsed 0 punches")) return raw;
  if (
    lower.includes("model did not return valid json") ||
    lower.includes("truncated") ||
    lower.includes("salvage")
  ) {
    return tr("customerUpload.errorAiInvalidJson");
  }
  if (
    lower.includes("did not return") ||
    lower.includes("ai extract") ||
    lower.includes("gemini") ||
    lower.includes("column") ||
    lower.includes("position")
  ) {
    return tr("customerUpload.errorAiGeneric");
  }
  return raw;
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

function mintProgressKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `pk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function startProgressPolling(
  weekStart: string,
  progressKey: string,
  onTick: (snap: {
    current: number;
    total: number;
    resumedFromStaging?: number;
  }) => void,
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
          | {
              current?: number;
              total?: number;
              resumedFromStaging?: number;
            }
          | null;
        if (
          body &&
          typeof body.current === "number" &&
          typeof body.total === "number"
        ) {
          onTick({
            current: body.current,
            total: body.total,
            ...(typeof body.resumedFromStaging === "number"
              ? { resumedFromStaging: body.resumedFromStaging }
              : {}),
          });
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

// ---------------------------------------------------------------------------
// Plain-JS store. The Provider component captures hook-only dependencies
// (toast, queryClient) into refs so the store's async actions can fire toasts
// and invalidate queries even while the panel that initiated the upload is
// unmounted.
// ---------------------------------------------------------------------------

interface StoreDeps {
  queryClient: QueryClient | null;
  toast: ToastFn | null;
}

class CustomerUploadStore {
  readonly deps: StoreDeps = { queryClient: null, toast: null };
  private weeks = new Map<string, WeekRecord>();
  private listeners = new Map<string, Set<() => void>>();

  private getOrCreate(weekStart: string): WeekRecord {
    let rec = this.weeks.get(weekStart);
    if (!rec) {
      rec = {
        state: {
          rowState: {},
          bulkItems: [],
          bulkRunning: false,
          pendingPreviews: [],
          version: 0,
        },
        rowAborts: new Map(),
        rowPollStops: new Map(),
        bulkAbort: null,
      };
      this.weeks.set(weekStart, rec);
    }
    return rec;
  }

  getWeekState(weekStart: string): WeekStateSnapshot {
    return this.getOrCreate(weekStart).state;
  }

  subscribe(weekStart: string, listener: () => void): () => void {
    let set = this.listeners.get(weekStart);
    if (!set) {
      set = new Set();
      this.listeners.set(weekStart, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private notify(weekStart: string) {
    const set = this.listeners.get(weekStart);
    if (!set) return;
    for (const l of set) l();
  }

  private mutate(
    weekStart: string,
    fn: (s: WeekStateSnapshot) => WeekStateSnapshot,
  ) {
    const rec = this.getOrCreate(weekStart);
    rec.state = fn(rec.state);
    this.notify(weekStart);
  }

  private setRow(
    weekStart: string,
    customer: string,
    patch: Partial<RowState>,
  ) {
    this.mutate(weekStart, (s) => {
      const prev = s.rowState[customer] ?? EMPTY_ROW_STATE;
      return {
        ...s,
        rowState: {
          ...s.rowState,
          [customer]: { ...EMPTY_ROW_STATE, ...prev, ...patch },
        },
      };
    });
  }

  private setBulkItems(
    weekStart: string,
    updater: (prev: BulkItem[]) => BulkItem[],
  ) {
    this.mutate(weekStart, (s) => ({ ...s, bulkItems: updater(s.bulkItems) }));
  }

  private invalidate(weekStart: string) {
    const qc = this.deps.queryClient;
    if (!qc) return;
    qc.invalidateQueries({
      queryKey: getGetCustomerUploadStatusQueryKey(weekStart),
    });
    qc.invalidateQueries({
      queryKey: getGetWeekSummaryQueryKey(weekStart),
    });
  }

  // ---------- Public actions ----------

  cancelRowUpload(weekStart: string, customer: string) {
    const rec = this.getOrCreate(weekStart);
    const c = rec.rowAborts.get(customer);
    if (c) {
      c.abort();
      rec.rowAborts.delete(customer);
    }
    const stop = rec.rowPollStops.get(customer);
    if (stop) {
      stop();
      rec.rowPollStops.delete(customer);
    }
    this.setRow(weekStart, customer, {
      uploading: false,
      error: null,
      uploadStartedAt: null,
      chunkProgress: null,
    });
  }

  /** Two-step preview flow used by per-row uploads (per-row picker + drag). */
  async extractFor(
    weekStart: string,
    customer: string,
    file: File,
    overrideTz: string,
  ): Promise<void> {
    const rec = this.getOrCreate(weekStart);
    // Tear down any in-flight upload on this row first.
    const prior = rec.rowAborts.get(customer);
    if (prior) prior.abort();
    const priorStop = rec.rowPollStops.get(customer);
    if (priorStop) priorStop();
    const controller = new AbortController();
    rec.rowAborts.set(customer, controller);
    this.setRow(weekStart, customer, {
      uploading: true,
      error: null,
      uploadStartedAt: Date.now(),
      chunkProgress: null,
    });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("customer", customer);
    if (overrideTz !== "__auto__") formData.append("dispTz", overrideTz);
    const progressKey = mintProgressKey();
    formData.append("progressKey", progressKey);
    const stopPolling = startProgressPolling(weekStart, progressKey, (snap) =>
      this.setRow(weekStart, customer, { chunkProgress: snap }),
    );
    rec.rowPollStops.set(customer, stopPolling);
    try {
      // Always force on user-initiated per-row uploads so identical
      // bytes still produce a preview the dispatcher can confirm-to-
      // replace, instead of the server short-circuiting with
      // `{ skipped: true }` and a confusing "already imported" toast.
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-customer-file?force=1`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
          signal: controller.signal,
        },
      );
      const body = (await res.json().catch(() => null)) as
        | (CustomerPreviewData & { skipped?: boolean; error?: string })
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(
          (body && "error" in body && body.error) ||
            tr("customerUpload.uploadFailedFallback"),
        );
      }
      const data = body as CustomerPreviewData & { skipped?: boolean };
      const isCurrent = rec.rowAborts.get(customer) === controller;
      if (!isCurrent) return;
      this.setRow(weekStart, customer, {
        uploading: false,
        error: null,
        uploadStartedAt: null,
      });
      // Task #381: never enqueue a `skipped:true` response as a preview —
      // it has `sampleId:null` and `rows:[]`, which would render an empty
      // preview dialog and trigger a DELETE /…/null on cancel. Surface a
      // neutral toast so the dispatcher knows the prior import is intact.
      if (data.skipped) {
        this.deps.toast?.({
          title: tr("customerUpload.alreadyImportedTitle", { customer }),
          description: tr("customerUpload.alreadyImportedDesc"),
        });
        return;
      }
      // Stash the preview so it survives the panel unmount/remount. Panel
      // pops these one at a time.
      this.mutate(weekStart, (s) => ({
        ...s,
        pendingPreviews: [...s.pendingPreviews, data],
      }));
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError");
      const isCurrent = rec.rowAborts.get(customer) === controller;
      if (!isCurrent && !aborted) return;
      if (isCurrent) {
        const raw = aborted
          ? tr("customerUpload.uploadCanceled")
          : errMessage(err, tr("customerUpload.uploadFailedFallback"));
        const msg = friendlyUploadError(raw);
        this.setRow(weekStart, customer, {
          uploading: false,
          error: aborted ? null : msg,
          uploadStartedAt: null,
          chunkProgress: null,
        });
        if (!aborted) {
          this.deps.toast?.({
            title: tr("customerUpload.extractFailedTitle", { customer }),
            description: msg,
            variant: "destructive",
          });
        }
      }
    } finally {
      if (rec.rowAborts.get(customer) === controller) {
        rec.rowAborts.delete(customer);
      }
      if (rec.rowPollStops.get(customer) === stopPolling) {
        rec.rowPollStops.delete(customer);
      }
      stopPolling();
      this.setRow(weekStart, customer, { chunkProgress: null });
    }
  }

  /** One-shot extract + confirm used by bulk and per-row "Re-upload" buttons. */
  private async doOneShot(
    weekStart: string,
    customer: string,
    file: File,
    overrideTz: string,
    opts: {
      force?: boolean;
      explicitCustomer?: boolean;
      signal?: AbortSignal;
      onProgress?: (snap: { current: number; total: number }) => void;
    },
  ): Promise<UploadResult> {
    const formData = new FormData();
    formData.append("file", file);
    if (overrideTz !== "__auto__") formData.append("dispTz", overrideTz);
    if (opts.explicitCustomer) formData.append("customer", customer);
    const progressKey = mintProgressKey();
    formData.append("progressKey", progressKey);
    const stopPolling = startProgressPolling(weekStart, progressKey, (snap) => {
      opts.onProgress?.(snap);
    });
    try {
      const qs = opts.force ? "?force=1" : "";
      const extractRes = await fetch(
        `${import.meta.env.BASE_URL}api/weeks/${weekStart}/extract-customer-file${qs}`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
          signal: opts.signal,
        },
      );
      const extractBody = (await extractRes.json().catch(() => null)) as
        | (CustomerPreviewData & { skipped?: boolean; error?: string })
        | { error?: string }
        | null;
      if (!extractRes.ok) {
        const msg =
          (extractBody && "error" in extractBody && extractBody.error) ||
          tr("customerUpload.uploadFailedFallback");
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
            ...(overrideTz !== "__auto__" ? { dispTz: overrideTz } : {}),
          }),
          signal: opts.signal,
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
          error:
            confirmBody?.error ?? tr("customerUpload.uploadFailedFallback"),
        };
      }
      return {
        ok: true,
        punches: confirmBody?.punchesUpserted ?? 0,
        unmapped: confirmBody?.unmappedIds ?? [],
        skipped: false,
      };
    } catch (err) {
      return {
        ok: false,
        error: errMessage(err, tr("customerUpload.uploadFailedFallback")),
      };
    } finally {
      stopPolling();
    }
  }

  /** Per-row "Re-upload" flow that bypasses the preview dialog. */
  async uploadFor(
    weekStart: string,
    customer: string,
    file: File,
    overrideTz: string,
  ): Promise<void> {
    const rec = this.getOrCreate(weekStart);
    const prior = rec.rowAborts.get(customer);
    if (prior) prior.abort();
    const controller = new AbortController();
    rec.rowAborts.set(customer, controller);
    this.setRow(weekStart, customer, {
      uploading: true,
      error: null,
      uploadStartedAt: Date.now(),
      chunkProgress: null,
    });
    const r = await this.doOneShot(weekStart, customer, file, overrideTz, {
      force: true,
      explicitCustomer: true,
      signal: controller.signal,
      onProgress: (snap) =>
        this.setRow(weekStart, customer, { chunkProgress: snap }),
    });
    const isCurrent = rec.rowAborts.get(customer) === controller;
    if (isCurrent) rec.rowAborts.delete(customer);
    const aborted = controller.signal.aborted;
    if (!r.ok) {
      if (aborted) {
        if (isCurrent) {
          this.setRow(weekStart, customer, {
            uploading: false,
            error: null,
            uploadStartedAt: null,
            chunkProgress: null,
          });
        }
        return;
      }
      if (!isCurrent) return;
      const msg = friendlyUploadError(r.error);
      this.setRow(weekStart, customer, {
        uploading: false,
        error: msg,
        uploadStartedAt: null,
        chunkProgress: null,
      });
      this.deps.toast?.({
        title: tr("customerUpload.uploadFailedTitle", { customer }),
        description: msg,
        variant: "destructive",
      });
      return;
    }
    if (!isCurrent) return;
    this.setRow(weekStart, customer, {
      uploading: false,
      error: null,
      uploadStartedAt: null,
      chunkProgress: null,
    });
    if (r.unmapped.length > 0) {
      const formatted = r.unmapped
        .map((u) => (u.sampleName ? `${u.id} (${u.sampleName})` : u.id))
        .join(", ");
      this.deps.toast?.({
        title: tr("customerUpload.uploadedWithUnknownTitle", {
          count: r.unmapped.length,
          customer,
        }),
        description: tr("customerUpload.uploadedWithUnknownDesc", {
          count: r.punches,
          ids: formatted,
        }),
        variant: "destructive",
      });
    } else {
      this.deps.toast?.({
        title: tr("customerUpload.uploadedTitle", { customer }),
        description: tr("customerUpload.uploadedDesc", { count: r.punches }),
      });
    }
    this.invalidate(weekStart);
  }

  /** Bulk drop / picker flow. */
  async runBulk(
    weekStart: string,
    files: File[],
    classify: (file: File) => string | null,
    overrideTz: string,
    onFirstFailedIdx?: (idx: number) => void,
  ): Promise<void> {
    if (files.length === 0) return;
    const rec = this.getOrCreate(weekStart);
    if (rec.state.bulkRunning) return;
    const initial: BulkItem[] = files.map((file) => {
      const customer = classify(file);
      return {
        file,
        customer,
        status: customer ? "pending" : "unknown",
      };
    });
    this.mutate(weekStart, (s) => ({
      ...s,
      bulkItems: initial,
      bulkRunning: true,
    }));
    const bulkAbort = new AbortController();
    rec.bulkAbort = bulkAbort;
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
      this.setBulkItems(weekStart, (prev) =>
        prev.map((it, idx) =>
          idx === i ? { ...it, status: "uploading" } : it,
        ),
      );
      this.setRow(weekStart, customer, { uploading: true, error: null });
      const r = await this.doOneShot(
        weekStart,
        customer,
        item.file,
        overrideTz,
        {
          // Always force in bulk too — dispatchers re-drop a whole
          // folder expecting it to replace the week's data, and the
          // server's same-bytes skip otherwise leaves stale rows in
          // place, which looks like the upload was ignored.
          force: true,
          explicitCustomer: true,
          signal: bulkAbort.signal,
        },
      );
      if (r.ok) {
        if (r.skipped) skipped++;
        else uploaded++;
        const warning = !r.skipped && r.unmapped.length > 0;
        this.setBulkItems(weekStart, (prev) =>
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
        this.setRow(weekStart, customer, { uploading: false, error: null });
      } else {
        failed++;
        if (firstFailedIdx === null) firstFailedIdx = i;
        const msg = friendlyUploadError(r.error);
        this.setBulkItems(weekStart, (prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "error", error: msg } : it,
          ),
        );
        this.setRow(weekStart, customer, { uploading: false, error: msg });
      }
    }
    this.mutate(weekStart, (s) => ({ ...s, bulkRunning: false }));
    rec.bulkAbort = null;
    this.invalidate(weekStart);
    const parts = [tr("customerUpload.bulkUploaded", { count: uploaded })];
    if (skipped > 0)
      parts.push(tr("customerUpload.bulkSkipped", { count: skipped }));
    if (needsReview > 0)
      parts.push(tr("customerUpload.bulkNeedReview", { count: needsReview }));
    parts.push(tr("customerUpload.bulkFailed", { count: failed }));
    const ff = firstFailedIdx;
    this.deps.toast?.({
      title: tr("customerUpload.bulkCompleteTitle"),
      description: parts.join(", ") + ".",
      variant: failed > 0 ? "destructive" : "default",
      action:
        ff != null && onFirstFailedIdx
          ? (
              <ToastAction
                altText={tr("customerUpload.showFirstFailureAlt")}
                onClick={() => onFirstFailedIdx(ff)}
              >
                {tr("customerUpload.showFirstFailure")}
              </ToastAction>
            )
          : undefined,
    });
  }

  dismissBulk(weekStart: string) {
    this.mutate(weekStart, (s) => ({ ...s, bulkItems: [] }));
  }

  /** Panel calls this after the preview dialog closes (confirm or cancel). */
  popPendingPreview(weekStart: string) {
    this.mutate(weekStart, (s) => ({
      ...s,
      pendingPreviews: s.pendingPreviews.slice(1),
    }));
  }
}

// ---------------------------------------------------------------------------
// React glue
// ---------------------------------------------------------------------------

const Ctx = createContext<CustomerUploadStore | null>(null);

export function CustomerUploadProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<CustomerUploadStore | null>(null);
  if (!storeRef.current) storeRef.current = new CustomerUploadStore();
  const store = storeRef.current;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Refresh deps on every render so the store always uses the live toast /
  // queryClient. Both are referentially stable so this is essentially a noop
  // after the first render.
  store.deps.queryClient = queryClient;
  store.deps.toast = toast;
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useCustomerUploads(): CustomerUploadStore {
  const store = useContext(Ctx);
  if (!store) {
    throw new Error(
      "useCustomerUploads must be used inside <CustomerUploadProvider>",
    );
  }
  return store;
}

export function useWeekUploadState(weekStart: string): WeekStateSnapshot {
  const store = useCustomerUploads();
  // useSyncExternalStore wants stable subscribe / getSnapshot per weekStart.
  const subscribeRef = useRef<((cb: () => void) => () => void) | null>(null);
  const getSnapshotRef = useRef<(() => WeekStateSnapshot) | null>(null);
  const lastWeek = useRef<string | null>(null);
  if (lastWeek.current !== weekStart) {
    lastWeek.current = weekStart;
    subscribeRef.current = (cb) => store.subscribe(weekStart, cb);
    getSnapshotRef.current = () => store.getWeekState(weekStart);
  }
  return useSyncExternalStore(subscribeRef.current!, getSnapshotRef.current!);
}

// Re-export for the panel.
export { friendlyUploadError };

// ---------------------------------------------------------------------------
// Cross-week cleanup helper used by tests / dev-only inspectors. Not exported
// from the panel module to keep the surface minimal.
// ---------------------------------------------------------------------------

export function _resetStoreForTests(store: CustomerUploadStore) {
  // Intentional no-op placeholder so the store class isn't accidentally
  // mutated from tests via private internals. The provider re-instantiates
  // the store on App remount, which is the supported reset path.
  void store;
}

/** Tick once a second while any row is uploading so elapsed-seconds badges
 * advance. Cheap — caller scopes the effect to the week and only mounts the
 * interval while a row is in flight. */
export function useElapsedTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
}
