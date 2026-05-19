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
    assert.equal(merged.length, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(merged[i].badgeOrId, `B${i}`);
    }
  } finally {
    __clearAiExtractStubs();
  }
});
