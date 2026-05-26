/**
 * Task #405: per-chunk yield sanity check.
 *
 * The chunked xlsx extractor used to rely solely on the
 * `parseOrSalvageJsonObject` "JSON didn't close cleanly" signal
 * (`truncated: true`) to know when to halve-and-retry a chunk. The
 * Burnett 5/17–5/23 incident showed a silent variant the old gate
 * doesn't catch: the model returned cleanly-closed JSON for the
 * second chunk but quietly dropped the trailing Saturday rows. With
 * `truncated: false`, the existing retry path never fired and the
 * importer wrote a partial set.
 *
 * The yield guard treats "model returned far fewer rows than the
 * chunk's CSV body contains" as a silent-truncation signal and runs
 * the same halve-and-retry path that explicit truncation already
 * uses. If the halved retry also under-yields, the upload fails
 * loudly instead of silently writing a partial set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  xlsxToChunks,
  aiExtractRows,
  __pushAiExtractStub,
  __clearAiExtractStubs,
  __chunkBodyLineCount,
  type AiExtractedRow,
} from "../aiExtract.js";

function makeWideRows(n: number): Buffer {
  const wide = "Y".repeat(120);
  const ws = XLSX.utils.json_to_sheet(
    Array.from({ length: n }, (_, i) => ({
      Name: `Driver ${i}`,
      Badge: `B${i}`,
      Date: "2026-05-12",
      In: "7:00 AM",
      Out: "3:00 PM",
      Notes: wide,
    })),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function makeRow(badge: string): AiExtractedRow {
  return {
    driverNameOnDoc: `driver-${badge}`,
    badgeOrId: badge,
    date: "2026-05-12",
    timeIn: "7:00 AM",
    timeOut: "3:00 PM",
  };
}

test("under-yield chunks trigger halve-and-retry; recovered rows land in merged output (Task #405)", async () => {
  // 240 rows produces exactly 2 chunks at the chunker's 120 rows/chunk
  // cap. With worker concurrency capped at chunks.length=2 the FIFO
  // stub queue is deterministic: first 2 stubs go to the initial
  // pass (one per chunk), the next 4 go to the halved retries (two
  // per chunk).
  const buf = makeWideRows(240);
  const chunks = xlsxToChunks(buf);
  assert.equal(chunks.length, 2, "test setup needs exactly 2 chunks");

  __clearAiExtractStubs();
  try {
    // Initial pass: both chunks return only 3 rows for ~120 input
    // lines → under-yield (3 < floor(120 * 0.5)=60) → both chunks
    // trigger the halve-and-retry path.
    __pushAiExtractStub([makeRow("init1-a"), makeRow("init1-b"), makeRow("init1-c")]);
    __pushAiExtractStub([makeRow("init2-a"), makeRow("init2-b"), makeRow("init2-c")]);
    // Halved retries: 4 stubs (two halves per chunk × two chunks),
    // each returning 50 rows. Half-input is ~60 lines so floor is
    // 30 — 50 clears it cleanly. Distinct badge prefixes prove the
    // halved-retry rows survived dedup into the final merged output.
    for (let i = 0; i < 4; i++) {
      __pushAiExtractStub(
        Array.from({ length: 50 }, (_, j) => makeRow(`retry-${i}-${j}`)),
      );
    }

    const out = await aiExtractRows(
      "wide.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
    );
    const retryBadgeCount = out.rows.filter((r) =>
      r.badgeOrId?.startsWith("retry-"),
    ).length;
    // 4 retry stubs × 50 rows = 200 rows of retry-prefixed badges.
    // All are unique so dedup keeps them. The exact number proves
    // every halved retry's output made it through, not just one.
    assert.equal(
      retryBadgeCount,
      200,
      "every halved-retry row must land in the merged output",
    );
    // And the merged output must NOT consist solely of the 6 sparse
    // rows the initial pass returned — that's the bug we're fixing.
    assert.ok(
      out.rows.length > 6,
      `merged output must contain recovered rows, got ${out.rows.length}`,
    );
  } finally {
    __clearAiExtractStubs();
  }
});

test("under-yield after halved retry rejects with the actionable error (Task #405)", async () => {
  const buf = makeWideRows(240);
  const chunks = xlsxToChunks(buf);
  assert.equal(chunks.length, 2, "test setup needs exactly 2 chunks");

  __clearAiExtractStubs();
  try {
    // Initial pass: both chunks sparse → both trip the guard.
    __pushAiExtractStub([makeRow("init1")]);
    __pushAiExtractStub([makeRow("init2")]);
    // Halved retries: all 4 halves also return 1 row for ~60 input
    // lines → still under 50% floor → guard re-trips → the runner
    // aborts with the "returned only X rows for Y input lines"
    // error rather than silently writing a partial set.
    for (let i = 0; i < 4; i++) {
      __pushAiExtractStub([makeRow(`retry-${i}`)]);
    }

    await assert.rejects(
      aiExtractRows(
        "wide.xlsx",
        buf,
        "TestCo",
        "2026-05-10",
        "2026-05-16",
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must reject with an Error");
        assert.match(
          err.message,
          /returned only \d+ rows for \d+ input lines after one retry/,
          "error must surface the input-vs-output row counts so the dispatcher knows why",
        );
        return true;
      },
    );
  } finally {
    __clearAiExtractStubs();
  }
});

test("yield-floor denominator skips comma-only spacer lines so sparse chunks don't false-trip the guard (Task #405)", () => {
  // Architect review of Task #405: `sheet_to_csv` retains rows that
  // have at least one non-empty cell, which means a sheet with many
  // mostly-empty columns can produce chunk bodies like
  //   "value,,,,,"
  //   ",,,,,"
  //   ",,,,,"
  // where most lines are comma/whitespace-only spacers. The model is
  // explicitly told it can skip those, so they must NOT inflate the
  // yield-floor denominator — otherwise a legitimately-extracted
  // chunk (30 real rows for 30 real data lines + 90 spacer lines)
  // would look like 30/120 = 25% yield, trigger a halve-and-retry,
  // and either succeed at double cost or hard-fail on the second
  // halved retry. This unit-tests the denominator helper directly.
  const marker = "FILE: sparse.xlsx";
  const header = "Name,Badge,Date,In,Out,Notes";
  const realRow = "Alice,B1,2026-05-12,7:00 AM,3:00 PM,";
  const commaSpacer = ",,,,,";
  const whitespaceSpacer = "   ,  ,";
  // 30 real data rows + 90 spacer rows (60 comma-only + 30 whitespace).
  const body = [
    ...Array.from({ length: 30 }, () => realRow),
    ...Array.from({ length: 60 }, () => commaSpacer),
    ...Array.from({ length: 30 }, () => whitespaceSpacer),
  ].join("\n");
  const chunk = [marker, header, body].join("\n");
  assert.equal(chunk.split("\n").length - 2, 120, "raw body must be 120 lines");
  assert.equal(
    __chunkBodyLineCount(chunk),
    30,
    "denominator must count only the 30 lines with real cell data",
  );
  // A 30-row model response against a 30-data-line chunk is 100%
  // yield → well above the 50% floor → no halve-and-retry fires.
  // (The yield check itself: outputRows < floor(inputRows * 0.5) →
  // 30 < 15 is false → guard does NOT trip. Cross-check via direct
  // assertion to pin the math.)
  const FLOOR = 0.5;
  const outputRows = 30;
  assert.ok(
    outputRows >= Math.floor(__chunkBodyLineCount(chunk) * FLOOR),
    "30 returned rows for a 30-real-line chunk must clear the 50% yield floor",
  );
});

test("Burnett-sized files (≤200 body rows) stay in the single-call path (Task #405)", () => {
  // 24 rows is the Burnett shape from the incident report. Even
  // with the workbook's noise lines, this must produce ONE chunk
  // so the silent-drop failure mode can't recur on Burnett-sized
  // files at all (defence in depth — the yield guard above covers
  // larger files that genuinely have to chunk).
  const buf = makeWideRows(24);
  const chunks = xlsxToChunks(buf);
  assert.equal(
    chunks.length,
    1,
    "Burnett-sized weekly exports must stay single-call after the threshold bump",
  );
});
