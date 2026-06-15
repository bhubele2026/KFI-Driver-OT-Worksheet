/**
 * Tiny `worker_threads` pool that offloads `XLSX.read` +
 * `sheet_to_csv` work to background threads (Task #403).
 *
 * The sync `xlsxToChunks` / `detectXlsxBlockStructure` exports in
 * `aiExtract.ts` can block the Node event loop for hundreds of ms
 * on multi-MB customer uploads. While one dispatcher uploads a 5MB
 * Penda export the API server can't serve any other request. Moving
 * the parse onto a worker keeps the main thread responsive.
 *
 * Design choices:
 * - The pool is lazily initialised on first use so process startup
 *   pays nothing and unit tests that never touch the upload path
 *   never spawn a worker.
 * - We keep the pool intentionally small (default 2 workers, capped
 *   to `os.cpus().length - 1`). Customer-file uploads are bursty —
 *   one dispatcher at a time, usually one file at a time — so a
 *   bigger pool wastes memory on idle threads.
 * - When the worker can't be spawned (e.g. running under tsx in unit
 *   tests where the `.ts` worker URL would need the tsx loader),
 *   we fall back to running the sync parser inline. This keeps the
 *   existing test suite green while still moving production traffic
 *   off the main thread.
 * - Buffers are passed by transferring the underlying ArrayBuffer
 *   when possible to avoid a structured-clone copy on every call.
 *   The caller's Buffer is consumed by `toTransferable` (which
 *   allocates a fresh ArrayBuffer slice) so the original Buffer
 *   remains valid for downstream attachment-part construction.
 */
import os from "node:os";
import { Worker } from "node:worker_threads";
import { logger } from "../logger.js";
import {
  detectXlsxBlockStructure as syncDetectXlsxBlockStructure,
  xlsxToChunks as syncXlsxToChunks,
} from "./aiExtract.js";

type ToChunksOpts = { forceChunkMaxRows?: number; maxRowsPerChunk?: number };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  worker: WorkerSlot;
};

type WorkerSlot = {
  worker: Worker;
  inflight: number;
};

// At least 2 parallel parse workers (the old Math.min(2, cpus-1) dropped
// to 1 on a 2-core Replit box), scaling up to 4 on larger hosts. Parsing
// is bursty and CPU-bound, so a handful of workers clears a multi-chunk
// upload's parse queue without starving request handling.
const POOL_MAX = Math.max(2, Math.min(4, (os.cpus()?.length ?? 2) - 1));

let pool: WorkerSlot[] | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;
let poolDisabled = false;

/**
 * Pick the worker file URL. In built output (`dist/xlsxWorker.mjs`)
 * the worker is bundled alongside the entrypoint. In source mode
 * (`tsx` tests / dev) the .ts file would need the tsx loader; rather
 * than wire that up, we leave the pool disabled and the sync
 * fallback runs everything inline. The whole point of the worker is
 * to keep production traffic off the main thread, and tests never
 * exercise multi-MB uploads.
 */
function resolveWorkerUrl(): URL | null {
  const here = import.meta.url;
  if (here.endsWith(".ts")) {
    // Running under tsx (tests / pre-build dev). Skip the worker.
    return null;
  }
  return new URL("./xlsxWorker.mjs", here);
}

function initPool(): WorkerSlot[] | null {
  if (pool) return pool;
  if (poolDisabled) return null;
  const url = resolveWorkerUrl();
  if (!url) {
    poolDisabled = true;
    return null;
  }
  try {
    const slots: WorkerSlot[] = [];
    for (let i = 0; i < POOL_MAX; i++) {
      const w = new Worker(url);
      const slot: WorkerSlot = { worker: w, inflight: 0 };
      w.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }): void => {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        p.worker.inflight = Math.max(0, p.worker.inflight - 1);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? "xlsx worker error"));
      });
      w.on("error", (err: unknown) => {
        // A worker died with an unhandled error; reject everything
        // routed through this slot so callers don't hang.
        const e = err instanceof Error ? err : new Error(String(err));
        logger.warn({ err: e.message }, "xlsx worker errored");
        for (const [id, p] of pending) {
          if (p.worker === slot) {
            pending.delete(id);
            p.reject(e);
          }
        }
        slot.inflight = 0;
      });
      w.on("exit", (code) => {
        if (code !== 0) {
          logger.warn({ code }, "xlsx worker exited unexpectedly");
        }
      });
      w.unref(); // don't keep the process alive on shutdown
      slots.push(slot);
    }
    pool = slots;
    return pool;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to spawn xlsx worker pool — falling back to inline parsing",
    );
    poolDisabled = true;
    return null;
  }
}

function pickSlot(slots: WorkerSlot[]): WorkerSlot {
  let best = slots[0];
  for (const s of slots) if (s.inflight < best.inflight) best = s;
  return best;
}

function toTransferable(buffer: Buffer): { view: Uint8Array; transfer: ArrayBuffer } {
  // Copy into a fresh ArrayBuffer we can transfer without
  // invalidating the caller's Buffer (which is reused downstream
  // for AI attachment parts on the same upload).
  const ab = new ArrayBuffer(buffer.byteLength);
  const view = new Uint8Array(ab);
  view.set(buffer);
  return { view, transfer: ab };
}

function dispatch<T>(
  op: "detectBlock" | "toChunks",
  buffer: Buffer,
  opts?: ToChunksOpts,
): Promise<T> {
  const slots = initPool();
  if (!slots) {
    // No worker available — run the sync impl inline. Wrapped in a
    // resolved promise so the call site is always async-shaped.
    if (op === "detectBlock") {
      return Promise.resolve(syncDetectXlsxBlockStructure(buffer) as unknown as T);
    }
    return Promise.resolve(syncXlsxToChunks(buffer, undefined, opts) as unknown as T);
  }
  const slot = pickSlot(slots);
  const id = nextId++;
  const { view, transfer } = toTransferable(buffer);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      worker: slot,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    slot.inflight++;
    try {
      slot.worker.postMessage(
        { id, op, buffer: view, opts },
        [transfer],
      );
    } catch (err) {
      pending.delete(id);
      slot.inflight = Math.max(0, slot.inflight - 1);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function detectXlsxBlockStructureAsync(buffer: Buffer): Promise<boolean> {
  return dispatch<boolean>("detectBlock", buffer);
}

export function xlsxToChunksAsync(
  buffer: Buffer,
  opts?: ToChunksOpts,
): Promise<string[]> {
  return dispatch<string[]>("toChunks", buffer, opts);
}

/**
 * Snapshot of the xlsx worker pool's load (Task #411).
 *
 * `workers` is the number of worker threads the pool would spawn (or
 * has spawned). `inflight` is the total number of tasks the pool is
 * currently servicing across all slots. `queued` is the count of
 * tasks that are waiting on a busy worker — i.e. submitted but not
 * yet picked up because every slot already has at least one task
 * running. The frontend uses `queued > 0` at submit time to warn the
 * dispatcher that their upload will sit behind other parses.
 *
 * When the worker pool is disabled (sync inline fallback — tsx tests,
 * worker spawn failed) we report zeros: every call runs synchronously
 * so there is no queue depth to surface.
 */
export interface XlsxWorkerPoolStats {
  workers: number;
  inflight: number;
  queued: number;
  disabled: boolean;
}

export function getXlsxWorkerPoolStats(): XlsxWorkerPoolStats {
  if (poolDisabled || !pool) {
    return { workers: 0, inflight: 0, queued: 0, disabled: true };
  }
  let inflight = 0;
  for (const s of pool) inflight += s.inflight;
  const workers = pool.length;
  const queued = Math.max(0, inflight - workers);
  return { workers, inflight, queued, disabled: false };
}

/**
 * Test-only hook: shut the pool down and forget any pending work.
 * Not used by production code paths.
 */
export async function _shutdownXlsxWorkerPool(): Promise<void> {
  const slots = pool;
  pool = null;
  poolDisabled = false;
  pending.clear();
  if (!slots) return;
  await Promise.all(slots.map((s) => s.worker.terminate()));
}
