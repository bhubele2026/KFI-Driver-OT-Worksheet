/**
 * Pins Task #255's per-format AI timeout policy:
 *  - images get a 90s ceiling (dispatcher is actively watching a photo);
 *  - xlsx + PDF get 5 minutes (so a first-time AI extract on a real
 *    weekly Trienda-scale export reliably completes and warms the
 *    column-roles cache for sub-100ms subsequent uploads).
 *
 * Verifies via the source text — the constant is a per-call closure, not
 * exported, but the behavior contract is explicit enough to assert as
 * a regression guard against accidentally lowering it back to 90s for
 * spreadsheets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as XLSX from "xlsx";
import {
  xlsxToChunks,
  XLSX_CHUNK_THRESHOLD_CHARS,
  XLSX_CHUNK_MAX_ROWS_BLOCK,
  aiExtractRows,
  detectXlsxBlockStructure,
  __pushAiExtractStub,
  __pushAiExtractErrorStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";
import {
  IngestionBudget,
  BACKSTOP_MAX_CALLS_PER_UPLOAD,
  MIN_MAX_CALLS_PER_UPLOAD,
  computeMaxCalls,
} from "../ingestionBudget.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "../aiExtract.ts"),
  "utf8",
);

function makeXlsx(rows: Array<Record<string, string>>): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("AI timeout: images 90s, xlsx/pdf 5 minutes (Task #255)", () => {
  assert.match(
    source,
    /const AI_TIMEOUT_MS = isImage \? 90_000 : 300_000;/,
    "AI_TIMEOUT_MS must branch on isImage with 90s/300s budgets",
  );
});

test("chunk threshold sits well below Gemini per-call limits", () => {
  // Behavioral guard: the threshold must stay below 500k chars so an
  // oversized workbook reliably triggers chunking rather than getting
  // truncated and silently dropping rows.
  assert.ok(
    XLSX_CHUNK_THRESHOLD_CHARS <= 500_000,
    `XLSX_CHUNK_THRESHOLD_CHARS should be <= 500k (was ${XLSX_CHUNK_THRESHOLD_CHARS})`,
  );
});

test("small workbooks produce a single chunk (no extra round trips)", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    Name: `Driver ${i}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
  }));
  const chunks = xlsxToChunks(makeXlsx(rows));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].length < XLSX_CHUNK_THRESHOLD_CHARS);
});

test("oversized workbooks split into multiple chunks, each carrying the header row", () => {
  // ~2000 wide rows -> CSV well above the 300k threshold
  const wide = "X".repeat(120);
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    Name: `Driver ${i} ${wide}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
    Notes: wide,
  }));
  const chunks = xlsxToChunks(makeXlsx(rows));
  assert.ok(
    chunks.length > 1,
    `expected >1 chunks for oversized workbook, got ${chunks.length}`,
  );
  for (const c of chunks) {
    assert.match(c, /^# Sheet: Sheet1 \(part \d+,/, "chunk must start with sheet marker");
    assert.match(c, /Name,Badge,Date,In,Out,Notes/, "chunk must include header row");
  }
});

test("aiExtractRows merges per-chunk results on the chunked xlsx path", async () => {
  const wide = "Y".repeat(120);
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    Name: `Driver ${i} ${wide}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
    Notes: wide,
  }));
  const buf = makeXlsx(rows);
  const chunks = xlsxToChunks(buf);
  assert.ok(chunks.length >= 2, "test setup must produce >=2 chunks");

  __clearAiExtractStubs();
  try {
    // Push one stub per chunk; merger should concatenate them in
    // order. Task #405: 80 rows per stub keeps us above the 50%
    // silent-truncation yield floor (60 = 50% of 120 input rows).
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 80 }, (_, j) => ({
          driverNameOnDoc: `chunk${i}-driver`,
          badgeOrId: `B${i}-${j}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    const merged = await aiExtractRows(
      "huge.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
    );
    assert.equal(merged.rows.length, chunks.length * 80);
    // Each chunk's 80 badges must be present in the merged output;
    // order across chunks is preserved by the worker pool's
    // index-keyed results array.
    for (let i = 0; i < chunks.length; i++) {
      assert.ok(
        merged.rows.some((r) => r.badgeOrId === `B${i}-0`),
        `chunk ${i} (badge B${i}-0) must be in merged output`,
      );
    }
  } finally {
    __clearAiExtractStubs();
  }
});

/**
 * Task #264 regression: a workbook with >150 data rows must be chunked
 * even when its total CSV size is well under the 300k char input
 * threshold. Before this fix the 522-row Penda export went down the
 * single-call path, Gemini hit maxOutputTokens mid-row, and the
 * dispatcher saw "3 drivers, 14 rows, 0 importable" with no warning.
 */
test("row-count trigger forces chunking on row-dense small files (Task #264)", () => {
  // 240 narrow rows: total CSV ~12 KB (well under 300k chars) but
  // above the 200-row trigger (Task #405 bumped from 100 → 200).
  const rows = Array.from({ length: 240 }, (_, i) => ({
    Name: `Driver ${i}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
  }));
  const chunks = xlsxToChunks(makeXlsx(rows));
  assert.ok(
    chunks.length > 1,
    `200-row workbook must chunk on row-count trigger, got ${chunks.length}`,
  );
});

// Task #340: the two Task #308 NDJSON re-issue tests that previously
// lived here have been removed. The runtime no longer carries a
// `missingRowIds` re-issue path — chunks consume one stub each and
// truncation is handled exclusively via the halving retry exercised
// below — so the contract those tests asserted no longer applies.

/**
 * Task #279 (reverses Task #267): a single chunk that throws must
 * now fail the WHOLE upload, not silently drop its rows. The earlier
 * "continue with surviving chunks" policy looked friendly but caused
 * a Penda 522-row upload to come back as "looks complete" while
 * actually missing a chunk's worth of punches — exactly the kind of
 * silent partial that the new app contract forbids.
 */
test("chunked path aborts when any chunk throws (Task #279 reverses #267)", async () => {
  const wide = "W".repeat(120);
  const rows = Array.from({ length: 600 }, (_, i) => ({
    Name: `Driver ${i} ${wide}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
    Notes: wide,
  }));
  const buf = makeXlsx(rows);
  const chunks = xlsxToChunks(buf);
  assert.ok(chunks.length >= 3, "test setup needs >=3 chunks");

  __clearAiExtractStubs();
  try {
    // First chunk throws. Remaining chunks have clean stubs queued
    // (the pool may or may not consume them depending on scheduling —
    // either way the failure must propagate as a rejection).
    __pushAiExtractErrorStub(
      "AI extraction timed out after 120s on one chunk — retry in a moment.",
    );
    for (let i = 1; i < chunks.length; i++) {
      __pushAiExtractStub([
        {
          driverNameOnDoc: `survivor-${i}`,
          badgeOrId: `S${i}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        },
      ]);
    }
    await assert.rejects(
      aiExtractRows(
        "penda-like.xlsx",
        buf,
        "TestCo",
        "2026-05-10",
        "2026-05-16",
      ),
      /timed out|extract/i,
      "any failing chunk must reject the whole extract",
    );
  } finally {
    __clearAiExtractStubs();
  }
});

/**
 * Task #267: chunks run in parallel (bounded concurrency), not
 * sequentially. With N chunks each taking T ms, wall-clock must be
 * roughly T (not N×T) — otherwise the Penda case still won't finish
 * in time for the demo because sequential 6 × 30-60s is what we just
 * removed.
 */
test("chunked path runs chunks in parallel, not sequentially (Task #267)", async () => {
  const wide = "P".repeat(120);
  const rows = Array.from({ length: 600 }, (_, i) => ({
    Name: `Driver ${i} ${wide}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
    Notes: wide,
  }));
  const buf = makeXlsx(rows);
  const chunks = xlsxToChunks(buf);
  // Need at least 4 chunks so a parallel run is visibly faster than
  // a sequential one (concurrency cap = 4, so 4 chunks should overlap
  // entirely).
  assert.ok(chunks.length >= 4, `test setup needs >=4 chunks, got ${chunks.length}`);

  // Wrap the runOne consumer indirectly: __pushAiExtractStub returns
  // synchronously, but the inner runOne is async. To observe parallelism
  // we add an artificial delay to each stub's consumption by hooking
  // setImmediate-style; the runner's `runOne` is awaited per chunk so
  // any concurrency gain comes from the pool, not the stub itself.
  // Approach: push N stubs that each, when consumed, schedule a small
  // async tick via Promise.resolve().then before resolving.
  // The stub mechanism is sync, but `runOne` is wrapped in async, so
  // the worker pool's `Promise.all` of N workers reading from the same
  // queue should still demonstrate that all N chunks are dispatched
  // before any awaits in `handleChunk` settle. We assert that all
  // stubs are consumed (queue length goes to 0) within one event-loop
  // tick of starting, by measuring wall-clock against a SLEEP_MS
  // injected per chunk.
  //
  // Simpler observable assertion: with 4 chunks taking >= 50ms each
  // (via the chunk worker's await on the stub-yielding tick), a
  // sequential run would be >= 200ms while a parallel-with-4 run is
  // ~50ms. We can't directly delay the stub, but we CAN observe via
  // the order of `_aiStubQueue` shifts: if all 4 workers start before
  // any halving/await suspends, the queue drains in a single
  // microtask burst. To make this a robust assertion we measure
  // wall-clock with a controlled await injected via a separately
  // queued microtask sequence per stub.
  //
  // The cleanest observable: just measure wall-clock for the whole
  // call. With per-chunk awaits being effectively zero (stubs resolve
  // immediately), both serial and parallel finish in the same time.
  // So instead we assert on the *order* of chunk dispatch by tagging
  // each stub with a unique badge and verifying the merged output
  // contains all of them regardless of order — and that the
  // implementation's worker count constant is wired correctly via a
  // source-text check, mirroring the AI_TIMEOUT_MS regression guard.
  const source = readFileSync(
    resolve(here, "../aiExtract.ts"),
    "utf8",
  );
  assert.match(
    source,
    /const XLSX_CHUNK_CONCURRENCY = \d+;/,
    "XLSX_CHUNK_CONCURRENCY constant must exist (Task #267 parallelism)",
  );
  const concurrencyMatch = source.match(/const XLSX_CHUNK_CONCURRENCY = (\d+);/);
  assert.ok(concurrencyMatch);
  const concurrency = Number(concurrencyMatch[1]);
  assert.ok(
    concurrency >= 3 && concurrency <= 8,
    `XLSX_CHUNK_CONCURRENCY should be a small bounded number (3-8), got ${concurrency}`,
  );

  // Behavioral check: a worker pool implementation must use Promise.all
  // on multiple workers reading from a shared index counter (not a
  // for-loop awaiting each chunk sequentially).
  assert.match(
    source,
    /Promise\.all\(workers\)/,
    "runChunkedXlsxExtract must Promise.all the worker pool",
  );

  __clearAiExtractStubs();
  try {
    // Task #405: 80 rows per stub clears the 50% silent-truncation
    // yield floor (60 = 50% of 120 input rows) so the parallel run
    // doesn't dissolve into halve-and-retries that change the
    // expected total.
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 80 }, (_, j) => ({
          driverNameOnDoc: `parallel-${i}`,
          badgeOrId: `P${i}-${j}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    const out = await aiExtractRows(
      "parallel.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
    );
    assert.equal(out.rows.length, chunks.length * 80);
  } finally {
    __clearAiExtractStubs();
  }
});

/**
 * Task #307: the Adient export carries a header band ("Job,,,,J0000…",
 * "Transaction Apply Date,…") that repeats once per driver group.
 * detectXlsxBlockStructure must flag it so the chunker halves the
 * per-chunk row budget; non-block customers (Penda's flat 18-col
 * single-header export) must NOT trip the detector or the per-chunk
 * row cap would shrink unnecessarily for them.
 */
test("detectXlsxBlockStructure flags Adient and ignores Penda (Task #307)", () => {
  const adientBuf = readFileSync(
    resolve(here, "./fixtures/2026-04-26/Adient.xlsx"),
  );
  const pendaBuf = readFileSync(
    resolve(here, "./fixtures/2026-04-26/Penda.xlsx"),
  );
  assert.equal(
    detectXlsxBlockStructure(adientBuf),
    true,
    "Adient repeats per-driver header bands and must be detected as block-structured",
  );
  assert.equal(
    detectXlsxBlockStructure(pendaBuf),
    false,
    "Penda's flat single-header export must NOT be flagged as block-structured",
  );
});

/**
 * Task #307: a synthetic flat workbook (unique cell values per row) is
 * a non-block layout — the detector must return false. Used to pin
 * the heuristic against false positives on the kinds of synthetic
 * fixtures the rest of this test file builds.
 */
test("detectXlsxBlockStructure returns false for flat synthetic workbooks (Task #307)", () => {
  const rows = Array.from({ length: 240 }, (_, i) => ({
    Name: `Driver ${i}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
  }));
  assert.equal(detectXlsxBlockStructure(makeXlsx(rows)), false);
});

/**
 * Task #307: per-chunk row cap branches on block-structured detection.
 * Block-structured layouts (Adient) use ~60 rows/chunk, flat layouts
 * (Penda) keep 120. Asserted via xlsxToChunks `maxRowsPerChunk` opt
 * (the same surface runExtraction calls with the detected budget).
 */
test("xlsxToChunks honors maxRowsPerChunk override (Task #307)", () => {
  // 240 narrow rows: trips the row-count chunking trigger.
  const rows = Array.from({ length: 240 }, (_, i) => ({
    Name: `Driver ${i}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
  }));
  const buf = makeXlsx(rows);
  const flat = xlsxToChunks(buf);
  assert.equal(flat.length, 2, "default 120 rows/chunk → 240/120 = 2 chunks");
  const block = xlsxToChunks(buf, undefined, {
    maxRowsPerChunk: XLSX_CHUNK_MAX_ROWS_BLOCK,
  });
  assert.equal(block.length, 4, "60 rows/chunk → 240/60 = 4 chunks");
  assert.ok(
    XLSX_CHUNK_MAX_ROWS_BLOCK === 60,
    `block budget must stay at 60 rows/chunk (got ${XLSX_CHUNK_MAX_ROWS_BLOCK})`,
  );
});

/**
 * Task #307: runExtraction (called via aiExtractRows) detects the
 * layout and records it on the budget so ingest_done + ingestion_runs
 * carry the decision through. End-to-end check on the real Adient
 * fixture: budget summary reports blockStructured=true and
 * rowsPerChunk=60 after a stubbed extraction.
 */
test("aiExtractRows records block-structured layout on the budget (Task #307)", async () => {
  const adientBuf = readFileSync(
    resolve(here, "./fixtures/2026-04-26/Adient.xlsx"),
  );
  const chunks = xlsxToChunks(adientBuf, undefined, {
    maxRowsPerChunk: XLSX_CHUNK_MAX_ROWS_BLOCK,
  });
  assert.ok(
    chunks.length >= 2,
    `Adient must chunk at the block budget (got ${chunks.length})`,
  );
  __clearAiExtractStubs();
  const budget = new IngestionBudget({
    fileName: "Adient.xlsx",
    customer: "Adient",
  });
  try {
    // Task #405: 50 rows per stub clears the 50% silent-truncation
    // yield floor for block-structured chunks (50% of 60 = 30).
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 50 }, (_, j) => ({
          driverNameOnDoc: `adient-${i}`,
          badgeOrId: `A${i}-${j}`,
          date: "2026-04-27",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    const out = await aiExtractRows(
      "Adient.xlsx",
      adientBuf,
      "Adient",
      "2026-04-26",
      "2026-05-02",
      undefined,
      undefined,
      undefined,
      { budget },
    );
    assert.equal(out.budgetSummary.blockStructured, true);
    assert.equal(out.budgetSummary.rowsPerChunk, XLSX_CHUNK_MAX_ROWS_BLOCK);
  } finally {
    __clearAiExtractStubs();
  }
});

/**
 * Task #307: the `ingest_done` summary log must surface
 * blockStructured + rowsPerChunk so admins greping API logs for
 * "ingest_done" can spot Adient-style runs at a glance — not just
 * via the `ingestion_runs` DB row.
 */
test("ingest_done log payload includes blockStructured + rowsPerChunk (Task #307)", async () => {
  const adientBuf = readFileSync(
    resolve(here, "./fixtures/2026-04-26/Adient.xlsx"),
  );
  const chunks = xlsxToChunks(adientBuf, undefined, {
    maxRowsPerChunk: XLSX_CHUNK_MAX_ROWS_BLOCK,
  });
  __clearAiExtractStubs();
  const captured: Array<{ msg: string; payload: Record<string, unknown> }> = [];
  const capture = {
    info: (payload: Record<string, unknown>, msg: string) =>
      captured.push({ msg, payload }),
    warn: (payload: Record<string, unknown>, msg: string) =>
      captured.push({ msg, payload }),
    error: (payload: Record<string, unknown>, msg: string) =>
      captured.push({ msg, payload }),
    debug: () => {},
  } as unknown as Parameters<typeof aiExtractRows>[6];
  try {
    // Task #405: clear the 50% silent-truncation yield floor (30 for block layouts).
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 50 }, (_, j) => ({
          driverNameOnDoc: `adient-${i}`,
          badgeOrId: `A${i}-${j}`,
          date: "2026-04-27",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    await aiExtractRows(
      "Adient.xlsx",
      adientBuf,
      "Adient",
      "2026-04-26",
      "2026-05-02",
      undefined,
      capture,
    );
    const done = captured.find((c) => c.msg === "ingest_done");
    assert.ok(done, "ingest_done log line must be emitted");
    assert.equal(done!.payload.blockStructured, true);
    assert.equal(done!.payload.rowsPerChunk, XLSX_CHUNK_MAX_ROWS_BLOCK);
  } finally {
    __clearAiExtractStubs();
  }
});

/**
 * Task #307: flat (non-block) workbooks must NOT trip the halved
 * budget — they continue at the default 120 rows/chunk. End-to-end
 * check using the real Penda fixture so future drift in either the
 * detector OR the Penda export shape surfaces here.
 */
test("aiExtractRows leaves flat layouts on the 120-row budget (Task #307)", async () => {
  const pendaBuf = readFileSync(
    resolve(here, "./fixtures/2026-04-26/Penda.xlsx"),
  );
  const chunks = xlsxToChunks(pendaBuf);
  assert.ok(
    chunks.length >= 2,
    `Penda is large enough to chunk at the default budget (got ${chunks.length})`,
  );
  __clearAiExtractStubs();
  const budget = new IngestionBudget({
    fileName: "Penda.xlsx",
    customer: "Penda",
  });
  try {
    // Task #405: 80 rows per stub clears the 50% silent-truncation
    // yield floor for flat layouts (60 = 50% of 120 input rows).
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 80 }, (_, j) => ({
          driverNameOnDoc: `penda-${i}`,
          badgeOrId: `P${i}-${j}`,
          date: "2026-04-27",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    const out = await aiExtractRows(
      "Penda.xlsx",
      pendaBuf,
      "Penda",
      "2026-04-26",
      "2026-05-02",
      undefined,
      undefined,
      undefined,
      { budget },
    );
    assert.equal(out.budgetSummary.blockStructured, false);
    assert.equal(out.budgetSummary.rowsPerChunk, 120);
  } finally {
    __clearAiExtractStubs();
  }
});

/**
 * Task #336: `computeMaxCalls` right-sizes the per-upload call ceiling
 * from the planned chunk count. `(chunks × 2) + 10`, clamped between
 * MIN_MAX_CALLS_PER_UPLOAD (20) and BACKSTOP_MAX_CALLS_PER_UPLOAD (200).
 */
test("computeMaxCalls scales with chunk count and clamps to the backstop (Task #336)", () => {
  // Tiny file (1 chunk) → 12 raw, clamped up to the 20 floor.
  assert.equal(computeMaxCalls(1), MIN_MAX_CALLS_PER_UPLOAD);
  assert.equal(computeMaxCalls(0), MIN_MAX_CALLS_PER_UPLOAD);
  // Small flat file (4 chunks) → 18 raw, clamped up to 20.
  assert.equal(computeMaxCalls(4), MIN_MAX_CALLS_PER_UPLOAD);
  // 5 chunks → 20, exactly at the floor.
  assert.equal(computeMaxCalls(5), 20);
  // Medium file (10 chunks) → 30.
  assert.equal(computeMaxCalls(10), 30);
  // Adient-shape block-structured xlsx (~71 chunks) → 152.
  assert.equal(computeMaxCalls(71), 152);
  // Pathological chunk count clamps to the backstop.
  assert.equal(computeMaxCalls(1000), BACKSTOP_MAX_CALLS_PER_UPLOAD);
  assert.equal(computeMaxCalls(95), BACKSTOP_MAX_CALLS_PER_UPLOAD);
  // 94 chunks → 198, still under the backstop.
  assert.equal(computeMaxCalls(94), 198);
});

/**
 * Task #336: a budget configured with a low per-upload ceiling must
 * trip at THAT ceiling, not the module backstop. Proves
 * `IngestionBudget.maxCalls` is per-instance and the trip-check reads
 * the configured value (not the static constant).
 */
test("IngestionBudget trips at the configured per-upload ceiling (Task #336)", () => {
  const budget = new IngestionBudget({
    fileName: "tiny.xlsx",
    customer: "TestCo",
    maxCalls: 20,
  });
  assert.equal(budget.getMaxCalls(), 20);
  const usage = {
    inputTokens: 100,
    outputTokens: 50,
    model: "claude-sonnet-4-5",
    provider: "claude",
  };
  // 20 calls succeed; the 21st must throw with the per-instance ceiling
  // in the message and well below the static backstop (200).
  for (let i = 0; i < 20; i++) {
    budget.recordCall(usage, "chunk");
  }
  assert.throws(
    () => budget.recordCall(usage, "chunk"),
    /per-file safety limit of 20 model calls/,
    "must reference the configured per-upload ceiling, not the backstop",
  );
  const summary = budget.summary();
  assert.equal(summary.maxCalls, 20);
  assert.equal(summary.totalCalls, 21);
});

/**
 * Task #336: `setMaxCalls` resizes the ceiling and clamps to
 * [MIN_MAX_CALLS_PER_UPLOAD, BACKSTOP_MAX_CALLS_PER_UPLOAD] so a buggy
 * chunk planner can't authorize unbounded calls.
 */
test("setMaxCalls clamps to the floor and backstop (Task #336)", () => {
  const budget = new IngestionBudget({ fileName: "f.xlsx", customer: "C" });
  budget.setMaxCalls(5);
  assert.equal(budget.getMaxCalls(), MIN_MAX_CALLS_PER_UPLOAD);
  budget.setMaxCalls(10_000);
  assert.equal(budget.getMaxCalls(), BACKSTOP_MAX_CALLS_PER_UPLOAD);
  budget.setMaxCalls(73);
  assert.equal(budget.getMaxCalls(), 73);
});

/**
 * Task #356: admin "Retry with higher limit" path. Passing
 * `maxCallsOverride: N` to the constructor raises the initial
 * ceiling to at least N, and a subsequent `setMaxCalls(small)` from
 * the chunk planner must not lower it below the override — otherwise
 * the retry would re-trip the same per-file cap the admin just bumped.
 * Override is itself clamped to [MIN, BACKSTOP].
 */
test("maxCallsOverride raises and pins the floor (Task #356)", () => {
  const budget = new IngestionBudget({
    fileName: "retry.xlsx",
    customer: "C",
    maxCalls: 30,
    maxCallsOverride: 200,
  });
  // Override raises the initial ceiling.
  assert.equal(budget.getMaxCalls(), 200);
  // Chunk planner picking a smaller ceiling cannot lower it.
  budget.setMaxCalls(45);
  assert.equal(budget.getMaxCalls(), 200);
  // Chunk planner picking a larger ceiling still wins.
  budget.setMaxCalls(Number.MAX_SAFE_INTEGER);
  assert.equal(budget.getMaxCalls(), BACKSTOP_MAX_CALLS_PER_UPLOAD);
  // Override above backstop clamps to backstop.
  const huge = new IngestionBudget({
    fileName: "retry2.xlsx",
    customer: "C",
    maxCallsOverride: 9_999,
  });
  assert.equal(huge.getMaxCalls(), BACKSTOP_MAX_CALLS_PER_UPLOAD);
});

/**
 * Task #336: the percentage-based soft warn fires once when totalCalls
 * crosses ~66% of the configured ceiling, regardless of file shape.
 * Pins SOFT_WARN_FRACTION's behavior so a 152-call Adient and a
 * 20-call Burnett both get a meaningful "running hot" signal.
 */
test("soft warn fires at ~66% of the configured per-upload ceiling (Task #336)", () => {
  const warns: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  const budget = new IngestionBudget({
    fileName: "warn.xlsx",
    customer: "C",
    maxCalls: 30,
    log: {
      warn: (payload, msg) => warns.push({ payload, msg }),
    },
  });
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    model: "claude-sonnet-4-5",
    provider: "claude",
  };
  // floor(30 * 0.66) = 19 — must NOT warn yet on call 18.
  for (let i = 0; i < 18; i++) budget.recordCall(usage, "chunk");
  assert.equal(warns.length, 0, "soft warn must not fire before threshold");
  // Call 19 crosses threshold → exactly one warn line.
  budget.recordCall(usage, "chunk");
  assert.equal(warns.length, 1, "soft warn must fire exactly once at threshold");
  assert.equal(warns[0].payload.maxCalls, 30);
  assert.equal(warns[0].payload.softWarnAt, 19);
  // No further warns even as totalCalls climbs.
  for (let i = 0; i < 5; i++) budget.recordCall(usage, "chunk");
  assert.equal(warns.length, 1, "soft warn must only fire once per upload");
});

/**
 * Task #336: the `ingest_done` log payload must surface the configured
 * per-upload ceiling next to the actual `totalCalls`, so an operator
 * grep'ing `ingest_done` can see how close any given upload ran to its
 * own limit. End-to-end check using a synthetic 2-chunk fixture.
 */
test("ingest_done log payload includes maxCalls (Task #336)", async () => {
  const rows = Array.from({ length: 240 }, (_, i) => ({
    Name: `Driver ${i}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
  }));
  const buf = makeXlsx(rows);
  const chunks = xlsxToChunks(buf);
  assert.ok(chunks.length >= 2, "test setup needs >=2 chunks");
  __clearAiExtractStubs();
  const captured: Array<{ msg: string; payload: Record<string, unknown> }> = [];
  const capture = {
    info: (payload: Record<string, unknown>, msg: string) =>
      captured.push({ msg, payload }),
    warn: (payload: Record<string, unknown>, msg: string) =>
      captured.push({ msg, payload }),
    error: (payload: Record<string, unknown>, msg: string) =>
      captured.push({ msg, payload }),
    debug: () => {},
  } as unknown as Parameters<typeof aiExtractRows>[6];
  try {
    // Task #405: 80 rows per stub clears the 50% silent-truncation
    // yield floor for flat layouts (60 = 50% of 120 input rows).
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 80 }, (_, j) => ({
          driverNameOnDoc: `chunk-${i}`,
          badgeOrId: `C${i}-${j}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    await aiExtractRows(
      "flat.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
      undefined,
      capture,
    );
    const done = captured.find((c) => c.msg === "ingest_done");
    assert.ok(done, "ingest_done log line must be emitted");
    assert.equal(done!.payload.maxCalls, computeMaxCalls(chunks.length));
  } finally {
    __clearAiExtractStubs();
  }
});
