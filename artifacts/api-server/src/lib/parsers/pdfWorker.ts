/**
 * Worker entrypoint for off-main-thread PDF text extraction
 * (Task #410, following the Task #403 xlsx-worker pattern).
 *
 * Runs as a `worker_threads` Worker spawned by `pdfWorkerPool.ts`.
 * Receives `{ id, op: "extractText", buffer }` messages on the
 * parent port, delegates to the existing `extractTextFromPdf`
 * implementation in `aiExtract.ts` (which uses pdfjs-dist/legacy),
 * and posts back `{ id, ok, result | error }`.
 *
 * Keeping the pdfjs `getDocument` / `getTextContent` loop in this
 * separate thread frees the API server's main event loop while a
 * dispatcher uploads a multi-page or scanned PDF — without it,
 * every other in-flight HTTP request stalls for hundreds of ms
 * during the parse (Task #401's per-page setImmediate yield helped
 * but was still single-threaded).
 */
import { parentPort } from "node:worker_threads";
import { extractTextFromPdf } from "./aiExtract.js";

type ExtractMsg = {
  id: number;
  op: "extractText";
  buffer: Uint8Array;
};

if (!parentPort) {
  throw new Error("pdfWorker must be spawned via worker_threads");
}

parentPort.on("message", (msg: ExtractMsg) => {
  // Re-wrap the transferred bytes as a Buffer so the parser sees
  // the same shape it does on the main thread.
  const buf = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
  void (async () => {
    try {
      if (msg.op === "extractText") {
        const result = await extractTextFromPdf(buf);
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
  })();
});
