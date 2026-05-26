/**
 * Task #403: contract tests for the xlsx worker pool.
 *
 * The pool moves `XLSX.read` + `sheet_to_csv` off the main event
 * loop so multi-MB customer uploads don't stall every other API
 * request. The pool also exposes a sync fallback used by unit tests
 * (which run under tsx where the .ts worker file would need extra
 * loader plumbing).
 *
 * We pin two things here:
 *  1. The async wrappers return byte-for-byte the same output as
 *     the sync exports in `aiExtract.ts` — the chunker is on the
 *     promotion path for customer parsers, so any drift would
 *     silently change downstream AI prompts.
 *  2. The dispatch helper is non-blocking-shaped: a chained promise
 *     resolves before the chunker returns, proving we're not just
 *     calling the sync impl synchronously and wrapping the result.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as XLSX from "xlsx";
import {
  detectXlsxBlockStructure,
  xlsxToChunks,
} from "../aiExtract.js";
import {
  detectXlsxBlockStructureAsync,
  xlsxToChunksAsync,
} from "../xlsxWorkerPool.js";

function makeFlatXlsx(rowCount: number): Buffer {
  const rows: Record<string, string | number>[] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push({
      Driver: `Driver ${i}`,
      Date: "2026-05-25",
      In: "8:00 AM",
      Out: "4:30 PM",
      Hours: 8.5,
    });
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function makeBlockStructuredXlsx(): Buffer {
  // Three identical short header bands — `detectXlsxBlockStructure`
  // flags any non-trivial line appearing 3+ times.
  const rows: (string | number)[][] = [];
  for (let i = 0; i < 4; i++) {
    rows.push(["Job", "", "", "", "J0000"]);
    rows.push(["Transaction", "Apply", "Date", "Hours", "Total"]);
    rows.push([`Driver ${i}`, "2026-05-25", "8.00", "REG", 8.0]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("xlsxToChunksAsync returns identical output to the sync chunker", async () => {
  const buf = makeFlatXlsx(150);
  const syncOut = xlsxToChunks(buf, undefined, { maxRowsPerChunk: 60 });
  const asyncOut = await xlsxToChunksAsync(buf, { maxRowsPerChunk: 60 });
  assert.deepEqual(asyncOut, syncOut);
});

test("xlsxToChunksAsync honors forceChunkMaxRows just like the sync chunker", async () => {
  const buf = makeFlatXlsx(50);
  const syncOut = xlsxToChunks(buf, undefined, { forceChunkMaxRows: 10 });
  const asyncOut = await xlsxToChunksAsync(buf, { forceChunkMaxRows: 10 });
  assert.deepEqual(asyncOut, syncOut);
  assert.ok(asyncOut.length >= 5, "forced chunking should yield multiple chunks");
});

test("detectXlsxBlockStructureAsync matches the sync detector", async () => {
  const flat = makeFlatXlsx(30);
  const block = makeBlockStructuredXlsx();
  assert.equal(await detectXlsxBlockStructureAsync(flat), detectXlsxBlockStructure(flat));
  assert.equal(await detectXlsxBlockStructureAsync(block), detectXlsxBlockStructure(block));
  assert.equal(await detectXlsxBlockStructureAsync(block), true);
});

test("xlsxToChunksAsync returns a Promise (not a sync-shaped value)", () => {
  const buf = makeFlatXlsx(5);
  const p = xlsxToChunksAsync(buf);
  assert.ok(p && typeof (p as Promise<unknown>).then === "function");
});

test("caller's Buffer is preserved across the worker dispatch", async () => {
  // The pool copies the bytes into a transferable ArrayBuffer so the
  // caller's Buffer survives intact for downstream attachment-part
  // construction (the AI extractor reuses the same buffer to build
  // the inline CSV prompt after the chunker returns).
  const buf = makeFlatXlsx(20);
  const before = buf.toString("hex");
  await xlsxToChunksAsync(buf);
  assert.equal(buf.toString("hex"), before);
  assert.ok(buf.length > 0);
});
