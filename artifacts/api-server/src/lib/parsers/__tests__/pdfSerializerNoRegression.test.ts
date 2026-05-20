/**
 * Task #375 regression guard. Runs the live `serializePdfTextItems`
 * against the IWG.pdf fixture (a flat single-baseline customer that
 * must NOT be touched by the stacked-cell merge) and asserts the
 * output matches the *legacy* serializer's output byte-for-byte.
 *
 * The architect review caught a real over-broad merge: the first
 * version of this fix fused independent IWG form-field rows because
 * geometry alone false-positived on "Status: Active" stacked above
 * "Status Date: 4/20/26". The semantic gate (upper = dates, lower =
 * times) plus this fixture-backed guard ensure the regression can't
 * silently come back.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializePdfTextItems } from "../aiExtract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IWG_FIXTURE = path.join(__dirname, "fixtures", "2026-04-26", "IWG.pdf");

// Mirror of the pre-Task-375 serializer. Used purely as the
// ground-truth "would the legacy code have produced this?" oracle.
function legacySerialize(
  items: Array<{ str: string; transform: number[] }>,
): string {
  const lines = new Map<number, Array<{ x: number; t: string }>>();
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = Math.round(item.transform[5]);
    const arr = lines.get(y) ?? [];
    arr.push({ x: item.transform[4], t: item.str });
    lines.set(y, arr);
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, its]) =>
      [...its].sort((a, b) => a.x - b.x).map((i) => i.t).join(" "),
    )
    .join("\n");
}

test("IWG.pdf serializes byte-for-byte identically to the legacy serializer (no merges)", async () => {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buf = readFileSync(IWG_FIXTURE);
  const doc = await mod.getDocument({ data: new Uint8Array(buf) } as Parameters<
    typeof mod.getDocument
  >[0]).promise;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: Array<{ str: string; transform: number[] }> = [];
      for (const it of content.items) {
        if (typeof (it as { str?: unknown }).str !== "string") continue;
        const ti = it as { str: string; transform: number[] };
        items.push({ str: ti.str, transform: ti.transform });
      }
      const legacy = legacySerialize(items);
      const next = serializePdfTextItems(items);
      assert.equal(
        next,
        legacy,
        `IWG.pdf page ${p}: serializer output diverged from legacy. ` +
          `If a stacked-cell merge fired here, the semantic gate is too loose.`,
      );
    }
  } finally {
    await doc.destroy();
  }
});
