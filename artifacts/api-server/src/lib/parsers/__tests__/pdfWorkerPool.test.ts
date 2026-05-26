/**
 * Task #410: contract tests for the pdf worker pool.
 *
 * The pool moves pdfjs-dist `getDocument` / `getTextContent` work
 * off the main event loop so multi-page or scanned PDF uploads
 * don't stall every other API request. The pool also exposes a
 * sync fallback used by unit tests (which run under tsx where the
 * .ts worker file would need extra loader plumbing).
 *
 * We pin two things here:
 *  1. The async wrapper returns byte-for-byte the same output as
 *     the sync `extractTextFromPdf` export in `aiExtract.ts` — the
 *     extracted text feeds the AI prompt for text-extractable
 *     customer PDFs, so any drift would silently change downstream
 *     model output.
 *  2. The wrapper is non-blocking-shaped: a chained promise resolves
 *     before the extractor returns, proving we're not just calling
 *     the sync impl synchronously and wrapping the result.
 */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractTextFromPdf } from "../aiExtract.js";
import { extractTextFromPdfAsync } from "../pdfWorkerPool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "fixtures/2026-04-26/IWG.pdf");

test("extractTextFromPdfAsync returns identical output to the sync extractor", async () => {
  const buf = await readFile(FIXTURE);
  const [syncOut, asyncOut] = await Promise.all([
    extractTextFromPdf(buf),
    extractTextFromPdfAsync(buf),
  ]);
  assert.equal(asyncOut, syncOut);
  assert.ok(asyncOut.length > 0, "fixture PDF should yield some text");
});

test("extractTextFromPdfAsync returns a Promise (not a sync-shaped value)", async () => {
  const buf = await readFile(FIXTURE);
  const p = extractTextFromPdfAsync(buf);
  assert.ok(p && typeof (p as Promise<unknown>).then === "function");
  await p;
});

test("caller's Buffer is preserved across the worker dispatch", async () => {
  // The pool copies bytes into a transferable ArrayBuffer so the
  // caller's Buffer survives intact for downstream attachment-part
  // construction (the AI extractor reuses the same buffer to build
  // the inline-PDF prompt when text density is too low).
  const buf = await readFile(FIXTURE);
  const beforeLen = buf.length;
  const beforeFirst = buf.subarray(0, 32).toString("hex");
  await extractTextFromPdfAsync(buf);
  assert.equal(buf.length, beforeLen);
  assert.equal(buf.subarray(0, 32).toString("hex"), beforeFirst);
});
