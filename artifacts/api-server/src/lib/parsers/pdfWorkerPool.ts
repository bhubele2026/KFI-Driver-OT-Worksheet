/**
 * Tiny `worker_threads` pool that offloads pdfjs-dist text extraction
 * (Task #410). Follows the same pattern as `xlsxWorkerPool.ts` from
 * Task #403.
 *
 * `extractTextFromPdf` in `aiExtract.ts` walks every page through
 * `pdfjs-dist/legacy` (`getDocument` + `getTextContent`) and can block
 * the Node event loop for hundreds of ms on multi-page or scanned
 * PDFs. Task #401 added a per-page `setImmediate` yield, but the work
 * still ran single-threaded on the API server's main loop. Moving the
 * parse onto a worker keeps the main thread responsive while a
 * dispatcher uploads a heavy PDF.
 *
 * Design choices mirror the xlsx pool:
 * - Lazy init: pool is created on first use, so process startup and
 *   tests that never touch the upload path don't spawn workers.
 * - Small pool (default 2, capped at `os.cpus().length - 1`): customer
 *   uploads are bursty — usually one dispatcher at a time.
 * - When the worker can't be spawned (running under tsx where the
 *   `.ts` worker URL would need the tsx loader), we fall back to
 *   running the sync impl inline. Tests stay green; production traffic
 *   still moves off the main thread.
 * - Buffers are passed by transferring a fresh ArrayBuffer copy so the
 *   caller's Buffer remains valid for downstream attachment-part
 *   construction (the AI extractor reuses the same buffer for the
 *   inline PDF prompt fallback when the text density is too low).
 */
import os from "node:os";
import { Worker } from "node:worker_threads";
import { logger } from "../logger.js";
import { extractTextFromPdf as syncExtractTextFromPdf } from "./aiExtract.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  worker: WorkerSlot;
};

type WorkerSlot = {
  worker: Worker;
  inflight: number;
};

const POOL_MAX = Math.max(1, Math.min(2, (os.cpus()?.length ?? 2) - 1));

let pool: WorkerSlot[] | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;
let poolDisabled = false;

function resolveWorkerUrl(): URL | null {
  const here = import.meta.url;
  if (here.endsWith(".ts")) {
    // Running under tsx (tests / pre-build dev). Skip the worker.
    return null;
  }
  return new URL("./pdfWorker.mjs", here);
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
        else p.reject(new Error(msg.error ?? "pdf worker error"));
      });
      w.on("error", (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        logger.warn({ err: e.message }, "pdf worker errored");
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
          logger.warn({ code }, "pdf worker exited unexpectedly");
        }
      });
      w.unref();
      slots.push(slot);
    }
    pool = slots;
    return pool;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to spawn pdf worker pool — falling back to inline parsing",
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
  const ab = new ArrayBuffer(buffer.byteLength);
  const view = new Uint8Array(ab);
  view.set(buffer);
  return { view, transfer: ab };
}

export function extractTextFromPdfAsync(buffer: Buffer): Promise<string> {
  const slots = initPool();
  if (!slots) {
    return syncExtractTextFromPdf(buffer);
  }
  const slot = pickSlot(slots);
  const id = nextId++;
  const { view, transfer } = toTransferable(buffer);
  return new Promise<string>((resolve, reject) => {
    pending.set(id, {
      worker: slot,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    slot.inflight++;
    try {
      slot.worker.postMessage(
        { id, op: "extractText", buffer: view },
        [transfer],
      );
    } catch (err) {
      pending.delete(id);
      slot.inflight = Math.max(0, slot.inflight - 1);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Test-only hook: shut the pool down and forget any pending work.
 * Not used by production code paths.
 */
export async function _shutdownPdfWorkerPool(): Promise<void> {
  const slots = pool;
  pool = null;
  poolDisabled = false;
  pending.clear();
  if (!slots) return;
  await Promise.all(slots.map((s) => s.worker.terminate()));
}
