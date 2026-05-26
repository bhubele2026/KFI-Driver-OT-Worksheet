/**
 * Worker entrypoint for off-main-thread xlsx parsing (Task #403).
 *
 * Runs as a `worker_threads` Worker spawned by `xlsxWorkerPool.ts`.
 * Receives `{ id, op, buffer, opts }` messages on the parent port,
 * delegates to the synchronous parser implementations in
 * `aiExtract.ts`, and posts back `{ id, ok, result | error }`.
 *
 * Keeping the heavy `XLSX.read` + `sheet_to_csv` calls in this
 * separate thread frees the API server's main event loop while a
 * dispatcher is uploading a multi-MB customer file — without it,
 * every other in-flight HTTP request stalls for hundreds of ms
 * during the parse.
 */
import { parentPort } from "node:worker_threads";
import {
  detectXlsxBlockStructure,
  xlsxToChunks,
} from "./aiExtract.js";

type DetectMsg = {
  id: number;
  op: "detectBlock";
  buffer: Uint8Array;
};

type ChunksMsg = {
  id: number;
  op: "toChunks";
  buffer: Uint8Array;
  opts?: { forceChunkMaxRows?: number; maxRowsPerChunk?: number };
};

type WorkerMsg = DetectMsg | ChunksMsg;

if (!parentPort) {
  throw new Error("xlsxWorker must be spawned via worker_threads");
}

parentPort.on("message", (msg: WorkerMsg) => {
  try {
    // Re-wrap the transferred bytes as a Buffer so the parser sees
    // the same shape it does on the main thread.
    const buf = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
    if (msg.op === "detectBlock") {
      const result = detectXlsxBlockStructure(buf);
      parentPort!.postMessage({ id: msg.id, ok: true, result });
    } else if (msg.op === "toChunks") {
      const result = xlsxToChunks(buf, undefined, msg.opts);
      parentPort!.postMessage({ id: msg.id, ok: true, result });
    } else {
      parentPort!.postMessage({
        id: (msg as { id: number }).id,
        ok: false,
        error: `unknown op: ${(msg as { op: string }).op}`,
      });
    }
  } catch (err) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
