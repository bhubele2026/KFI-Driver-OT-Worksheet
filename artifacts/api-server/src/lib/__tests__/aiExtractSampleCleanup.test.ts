import test from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";

import { db, schema } from "../db.js";
import { purgeExpiredAiExtractSamples } from "../aiExtractSampleCleanup.js";

// Guards the cleanup sweep's WHERE clause: pinned samples must survive even
// after their TTL is up, otherwise engineers lose the fixtures they pinned
// on purpose. Seeds three rows (expired+unpinned, expired+pinned,
// fresh+unpinned), runs the purge, and asserts only the expired+unpinned
// row was deleted.

test("purgeExpiredAiExtractSamples deletes only expired, unpinned rows", async () => {
  const tag = `cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const inserted = await db
    .insert(schema.aiExtractSamplesTable)
    .values([
      {
        weekStart: "2026-04-26",
        customer: tag,
        fileName: "expired-unpinned.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        fileBytes: Buffer.from([0]),
        expiresAt: past,
        pinned: false,
      },
      {
        weekStart: "2026-04-26",
        customer: tag,
        fileName: "expired-pinned.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        fileBytes: Buffer.from([0]),
        expiresAt: past,
        pinned: true,
      },
      {
        weekStart: "2026-04-26",
        customer: tag,
        fileName: "fresh-unpinned.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        fileBytes: Buffer.from([0]),
        expiresAt: future,
        pinned: false,
      },
    ])
    .returning({
      id: schema.aiExtractSamplesTable.id,
      fileName: schema.aiExtractSamplesTable.fileName,
    });

  const ids = inserted.map((r) => r.id);

  try {
    await purgeExpiredAiExtractSamples();

    const survivors = await db
      .select({
        id: schema.aiExtractSamplesTable.id,
        fileName: schema.aiExtractSamplesTable.fileName,
      })
      .from(schema.aiExtractSamplesTable)
      .where(inArray(schema.aiExtractSamplesTable.id, ids));

    const survivorNames = new Set(survivors.map((r) => r.fileName));
    assert.ok(
      !survivorNames.has("expired-unpinned.bin"),
      "expired+unpinned row should have been purged",
    );
    assert.ok(
      survivorNames.has("expired-pinned.bin"),
      "expired+pinned row must survive the purge",
    );
    assert.ok(
      survivorNames.has("fresh-unpinned.bin"),
      "fresh+unpinned row must survive the purge",
    );
    assert.equal(survivors.length, 2, "exactly two seeded rows should survive");
  } finally {
    // Delete by every seeded id (not just expected survivors) so the test is
    // fully self-cleaning even if the purge regresses and leaves rows behind.
    if (ids.length > 0) {
      await db
        .delete(schema.aiExtractSamplesTable)
        .where(inArray(schema.aiExtractSamplesTable.id, ids));
    }
  }
});
