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
  aiExtractRows,
  __pushAiExtractStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";

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
    // Push one stub per chunk; merger should concatenate them in order.
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub([
        {
          driverNameOnDoc: `chunk${i}-driver`,
          badgeOrId: `B${i}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        },
      ]);
    }
    const merged = await aiExtractRows(
      "huge.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
    );
    assert.equal(merged.rows.length, chunks.length);
    assert.equal(merged.truncated, false);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(merged.rows[i].badgeOrId, `B${i}`);
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
  // 200 narrow rows: total CSV ~10 KB (well under 300k chars) but well
  // above the 150-row trigger.
  const rows = Array.from({ length: 200 }, (_, i) => ({
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

/**
 * Task #264 regression: when the single-call response comes back
 * truncated, aiExtractRows must auto-recover by re-extracting via
 * forced chunking instead of silently returning the partial salvage.
 * This is the safety net for the rare case where a workbook slips
 * under the 150-row trigger but still busts the 32k output-token cap
 * (e.g. extremely verbose pay-category splits).
 */
test("single-call truncation auto-recovers via forced chunking (Task #264)", async () => {
  // 10 rows: total CSV well under both triggers — single-call path.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    Name: `Driver ${i}`,
    Badge: `B${i}`,
    Date: "2026-05-12",
    In: "7:00 AM",
    Out: "3:00 PM",
  }));
  const buf = makeXlsx(rows);
  // Sanity-check the test setup: this file is small enough to take the
  // single-call path, so the truncation-retry path is what we're
  // actually exercising.
  assert.equal(
    xlsxToChunks(buf).length,
    1,
    "test setup must produce a single chunk so the single-call path runs",
  );

  __clearAiExtractStubs();
  try {
    // 1st stub: single-call returns truncated partial (2 rows).
    __pushAiExtractStub(
      [
        {
          driverNameOnDoc: "partial-1",
          badgeOrId: "B0",
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        },
        {
          driverNameOnDoc: "partial-2",
          badgeOrId: "B1",
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        },
      ],
      { truncated: true },
    );
    // 2nd+ stubs: the forced-rechunk path. 10 rows with forceChunkMaxRows=100
    // → still one chunk on re-extract; push one clean stub to satisfy it.
    __pushAiExtractStub([
      {
        driverNameOnDoc: "rechunk-driver",
        badgeOrId: "RECHUNK",
        date: "2026-05-12",
        timeIn: "7:00 AM",
        timeOut: "3:00 PM",
      },
    ]);
    const out = await aiExtractRows(
      "small.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
    );
    // Critical assertion: the SALVAGED partial rows were discarded in
    // favor of the re-chunked clean run.
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].badgeOrId, "RECHUNK");
    assert.equal(
      out.truncated,
      false,
      "successful re-chunk recovery should clear the truncated flag",
    );
  } finally {
    __clearAiExtractStubs();
  }
});

/**
 * Task #264: when a chunk in the multi-chunk path comes back truncated,
 * runChunkedXlsxExtract halves it and retries each half. Surfaces a
 * `truncated: true` flag only if even the halves can't recover all rows.
 */
test("chunked path halves and retries a truncated chunk (Task #264)", async () => {
  const wide = "Z".repeat(120);
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
  assert.ok(chunks.length >= 2, "test setup needs >=2 chunks");

  __clearAiExtractStubs();
  try {
    // First chunk: truncated. Halving retry produces 2 sub-requests.
    __pushAiExtractStub(
      [
        {
          driverNameOnDoc: "first-partial",
          badgeOrId: "P0",
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        },
      ],
      { truncated: true },
    );
    // Halved retry 1.1 and 1.2: both clean.
    __pushAiExtractStub([
      {
        driverNameOnDoc: "half-1",
        badgeOrId: "H1",
        date: "2026-05-12",
        timeIn: "7:00 AM",
        timeOut: "3:00 PM",
      },
    ]);
    __pushAiExtractStub([
      {
        driverNameOnDoc: "half-2",
        badgeOrId: "H2",
        date: "2026-05-12",
        timeIn: "7:00 AM",
        timeOut: "3:00 PM",
      },
    ]);
    // Remaining chunks: one clean stub each.
    for (let i = 1; i < chunks.length; i++) {
      __pushAiExtractStub([
        {
          driverNameOnDoc: `chunk${i}`,
          badgeOrId: `C${i}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        },
      ]);
    }
    const out = await aiExtractRows(
      "huge.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
    );
    // The halved-retry rows replace the truncated partial for that
    // chunk: runChunkedXlsxExtract appends the two half results in
    // place of the original chunk's salvaged partial.
    const badges = out.rows.map((r) => r.badgeOrId);
    assert.ok(badges.includes("H1"), "halved retry 1 row must survive");
    assert.ok(badges.includes("H2"), "halved retry 2 row must survive");
    assert.equal(
      out.truncated,
      false,
      "successful halving should clear the truncated flag",
    );
  } finally {
    __clearAiExtractStubs();
  }
});
