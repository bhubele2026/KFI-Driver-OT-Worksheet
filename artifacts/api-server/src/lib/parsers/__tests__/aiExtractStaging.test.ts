/**
 * Task #309: per-chunk resume staging. When a chunked xlsx extract
 * fails mid-flight, every chunk that finished cleanly is checkpointed
 * to a staging table. A re-upload of the same file bytes for the same
 * (week, customer) loads those checkpoints and short-circuits Claude
 * for chunks already in hand — only the missing chunks get fresh
 * model calls. On full success, the staging block is cleared.
 *
 * This test drives the contract end-to-end via the injectable
 * `ChunkStageStore` seam: an in-memory store stands in for the live
 * DB-backed one so the test can observe save / load / clear directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import {
  xlsxToChunks,
  aiExtractRows,
  __pushAiExtractStub,
  __pushAiExtractErrorStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";
import type { AiExtractedRow } from "../aiExtract.js";
import type { ChunkStageStore } from "../aiExtractStage.js";
import { makeUploadKey } from "../aiExtractStage.js";

function makeXlsx(rows: Array<Record<string, string>>): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

interface SaveCall {
  uploadKey: string;
  chunkIndex: number;
  chunkCount: number;
  rows: AiExtractedRow[];
}

function inMemoryStore(): ChunkStageStore & {
  saves: SaveCall[];
  clears: string[];
  loads: string[];
  data: Map<string, Map<number, AiExtractedRow[]>>;
} {
  const data = new Map<string, Map<number, AiExtractedRow[]>>();
  const saves: SaveCall[] = [];
  const clears: string[] = [];
  const loads: string[] = [];
  return {
    saves,
    clears,
    loads,
    data,
    async load(uploadKey) {
      loads.push(uploadKey);
      return new Map(data.get(uploadKey) ?? new Map());
    },
    async save(args) {
      saves.push({
        uploadKey: args.uploadKey,
        chunkIndex: args.chunkIndex,
        chunkCount: args.chunkCount,
        rows: args.extractedRows,
      });
      let bucket = data.get(args.uploadKey);
      if (!bucket) {
        bucket = new Map();
        data.set(args.uploadKey, bucket);
      }
      bucket.set(args.chunkIndex, args.extractedRows);
    },
    async clear(uploadKey) {
      clears.push(uploadKey);
      data.delete(uploadKey);
    },
  };
}

function makeWideRows(n: number, badgePrefix = "B"): Buffer {
  const wide = "Y".repeat(120);
  return makeXlsx(
    Array.from({ length: n }, (_, i) => ({
      Name: `Driver ${i} ${wide}`,
      Badge: `${badgePrefix}${i}`,
      Date: "2026-05-12",
      In: "7:00 AM",
      Out: "3:00 PM",
      Notes: wide,
    })),
  );
}

test("makeUploadKey is stable for same bytes + week + customer and differs otherwise", () => {
  const hashA = createHash("sha256").update(Buffer.from("aaa")).digest("hex");
  const hashB = createHash("sha256").update(Buffer.from("bbb")).digest("hex");
  const k1 = makeUploadKey({
    contentHash: hashA,
    weekStart: "2026-05-10",
    customer: "Penda",
  });
  const k2 = makeUploadKey({
    contentHash: hashA,
    weekStart: "2026-05-10",
    customer: "penda",
  });
  const k3 = makeUploadKey({
    contentHash: hashB,
    weekStart: "2026-05-10",
    customer: "Penda",
  });
  const k4 = makeUploadKey({
    contentHash: hashA,
    weekStart: "2026-05-17",
    customer: "Penda",
  });
  assert.equal(k1, k2, "customer comparison must be case-insensitive");
  assert.notEqual(k1, k3, "different bytes → different key");
  assert.notEqual(k1, k4, "different week → different key");
});

test("clean chunked run saves each chunk then clears staging on success (Task #309)", async () => {
  const buf = makeWideRows(2000);
  const chunks = xlsxToChunks(buf);
  assert.ok(chunks.length >= 2, "test setup needs >=2 chunks");

  const store = inMemoryStore();
  const uploadKey = makeUploadKey({
    contentHash: createHash("sha256").update(buf).digest("hex"),
    weekStart: "2026-05-10",
    customer: "TestCo",
  });
  __clearAiExtractStubs();
  try {
    // Task #405: each stub must return enough rows to clear the
    // 50% yield floor (chunks are 120 input lines → floor = 60),
    // otherwise the new silent-truncation guard halves and retries
    // and the staging assertions below see 2x rows per chunk.
    for (let i = 0; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 80 }, (_, j) => ({
          driverNameOnDoc: `chunk${i}`,
          badgeOrId: `B${i}-${j}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    const out = await aiExtractRows(
      "huge.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
      undefined,
      undefined,
      undefined,
      { uploadKey, stageStore: store },
    );
    assert.equal(out.rows.length, chunks.length * 80);
    assert.equal(
      store.saves.length,
      chunks.length,
      "every chunk must persist on success",
    );
    assert.deepEqual(
      store.clears,
      [uploadKey],
      "the upload key must be cleared exactly once on full success",
    );
    assert.equal(
      store.data.size,
      0,
      "in-memory store must be empty after the success clear",
    );
  } finally {
    __clearAiExtractStubs();
  }
});

test("failure mid-run leaves successful chunks staged; resume skips them and finishes (Task #309)", async () => {
  // 600 wide rows reliably produces multiple chunks under the default
  // row-per-chunk budget. The runner dispatches all chunks in parallel
  // from a bounded worker pool, so we can't pin "exactly chunk 3 fails";
  // instead we let the first chunk fail and assert that EVERY chunk
  // that DID succeed before the abort propagated lands in staging.
  const buf = makeWideRows(600);
  const chunks = xlsxToChunks(buf);
  assert.ok(chunks.length >= 3, "test setup needs >=3 chunks");

  const store = inMemoryStore();
  const uploadKey = makeUploadKey({
    contentHash: createHash("sha256").update(buf).digest("hex"),
    weekStart: "2026-05-10",
    customer: "TestCo",
  });

  // First attempt: chunk 0 throws; remaining chunks have clean stubs.
  // Whatever chunks finished before the abort propagated must be
  // present in the staging store.
  __clearAiExtractStubs();
  try {
    __pushAiExtractErrorStub(
      "AI extraction timed out after 120s on one chunk — retry in a moment.",
    );
    // Task #405: 80 rows per stub clears the silent-truncation
    // yield floor (60 = 50% of the 120-line chunk body) so the
    // survivors aren't halve-and-retried into 2x rows per chunk.
    for (let i = 1; i < chunks.length; i++) {
      __pushAiExtractStub(
        Array.from({ length: 80 }, (_, j) => ({
          driverNameOnDoc: `survivor-${i}`,
          badgeOrId: `S${i}-${j}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    await assert.rejects(
      aiExtractRows(
        "huge.xlsx",
        buf,
        "TestCo",
        "2026-05-10",
        "2026-05-16",
        undefined,
        undefined,
        undefined,
        { uploadKey, stageStore: store },
      ),
      /timed out|extract/i,
    );
  } finally {
    __clearAiExtractStubs();
  }

  const stagedAfterFailure = store.data.get(uploadKey);
  assert.ok(
    stagedAfterFailure && stagedAfterFailure.size > 0,
    "at least one chunk that completed before the abort must have been staged",
  );
  assert.ok(
    !stagedAfterFailure!.has(0),
    "the chunk that threw must NOT be present in staging",
  );
  assert.equal(
    store.clears.length,
    0,
    "a failed run must not clear the staging block",
  );
  const stagedIndices = [...stagedAfterFailure!.keys()].sort((a, b) => a - b);

  // Second attempt: identical bytes/customer/week → identical uploadKey.
  // The runner loads stagedAfterFailure, skips those chunks (no stub
  // consumed for them), and only the MISSING chunks (chunk 0 plus any
  // chunks whose worker hadn't picked them up before the abort) get
  // fresh stubs. After the run, every chunk must be in `out.rows` and
  // staging must be cleared.
  const missingIndices = chunks
    .map((_, i) => i)
    .filter((i) => !stagedAfterFailure!.has(i));
  assert.ok(missingIndices.includes(0), "chunk 0 must remain to be re-run");

  __clearAiExtractStubs();
  try {
    // Queue one stub per missing chunk, tagged so we can verify both
    // the resumed rows (from the in-memory store) and the freshly-
    // extracted rows (from the new stubs) end up in the merged result.
    for (const idx of missingIndices) {
      // Task #405: 80 rows per stub keeps the resumed-run stubs
      // above the silent-truncation yield floor (50% of 120 = 60).
      __pushAiExtractStub(
        Array.from({ length: 80 }, (_, j) => ({
          driverNameOnDoc: `resume-${idx}`,
          badgeOrId: `R${idx}-${j}`,
          date: "2026-05-12",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
        })),
      );
    }
    const out = await aiExtractRows(
      "huge.xlsx",
      buf,
      "TestCo",
      "2026-05-10",
      "2026-05-16",
      undefined,
      undefined,
      undefined,
      { uploadKey, stageStore: store },
    );
    // Every chunk's rows must be in the merged output (staged +
    // resumed). 80 rows per chunk after the Task #405 stub bump.
    assert.equal(out.rows.length, chunks.length * 80);
    const badges = out.rows.map((r) => r.badgeOrId ?? "");
    for (const stagedIdx of stagedIndices) {
      assert.ok(
        badges.some((b) => b.startsWith(`S${stagedIdx}-`)),
        `staged chunk ${stagedIdx} (badges S${stagedIdx}-*) must be in resumed output`,
      );
    }
    for (const missingIdx of missingIndices) {
      assert.ok(
        badges.some((b) => b.startsWith(`R${missingIdx}-`)),
        `re-run chunk ${missingIdx} (badges R${missingIdx}-*) must be in merged output`,
      );
    }
    assert.deepEqual(
      store.clears.slice(-1),
      [uploadKey],
      "successful resume must clear the staging block",
    );
    assert.equal(
      store.data.size,
      0,
      "staging must be empty after successful resume",
    );
  } finally {
    __clearAiExtractStubs();
  }
});

test("different file bytes mint different upload keys (no cross-file resume bleed)", () => {
  const bufA = makeWideRows(600, "A");
  const bufB = makeWideRows(600, "B");
  const keyA = makeUploadKey({
    contentHash: createHash("sha256").update(bufA).digest("hex"),
    weekStart: "2026-05-10",
    customer: "TestCo",
  });
  const keyB = makeUploadKey({
    contentHash: createHash("sha256").update(bufB).digest("hex"),
    weekStart: "2026-05-10",
    customer: "TestCo",
  });
  assert.notEqual(
    keyA,
    keyB,
    "different content hashes must produce different upload keys",
  );
});
