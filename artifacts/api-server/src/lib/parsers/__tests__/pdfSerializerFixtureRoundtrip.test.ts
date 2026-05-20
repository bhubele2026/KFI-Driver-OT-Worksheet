/**
 * Task #375 end-to-end positive test. Builds a tiny text-extractable
 * PDF on the fly with pdfkit whose layout matches DeLallo's
 * daily-punches "date on top, time on the line directly below"
 * cell stacking, then runs the real pdfjs `getDocument` →
 * `getTextContent` path through `serializePdfTextItems` and asserts
 * the date/time pairs land on the same logical line.
 *
 * This is the missing positive fixture-backed coverage the architect
 * review called out: the synthetic-items tests in
 * `pdfSerializerStackedCells.test.ts` exercise the serializer
 * directly but don't prove the end-to-end pdfjs → serializer wiring
 * actually pairs cells on a live PDF. The repo's DeLallo.pdf fixture
 * is a scanned image (zero pdfjs text items) so it can't fill this
 * role; we generate a hermetic replacement here instead of adding a
 * binary fixture.
 *
 * Also asserts that the new serializer's output *differs* from the
 * legacy y-band-only serializer on this PDF, proving the merge
 * actually fires where it should.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializePdfTextItems } from "../aiExtract.js";

// Hand-rolled minimal PDF — three text objects on the top line
// (dates 05/10, 05/11, 05/12) and three on the line directly below
// (times 6:00AM, 6:10AM, 6:20AM), aligned column-wise. The line
// gap is ~12pt, well within STACK_MAX_GAP=14, so the serializer
// must pair them. Built by hand so the test has zero dependencies
// beyond pdfjs-dist (already pinned in artifacts/api-server).
function buildStackedCellPdf(): Buffer {
  // Six text objects: dates on y=720, times on y=708 (12pt gap).
  // x positions: 100 / 200 / 300.
  // NOTE: each Tj content is a single space-free token. pdfjs
  // splits any internal whitespace into separate items, which
  // would break the lower-band item-count match. The TIME_LIKE_RE
  // accepts both "6:00 AM" and "6:00AM" forms.
  const stream =
    "BT /F1 10 Tf 100 720 Td (05/10) Tj ET\n" +
    "BT /F1 10 Tf 200 720 Td (05/11) Tj ET\n" +
    "BT /F1 10 Tf 300 720 Td (05/12) Tj ET\n" +
    "BT /F1 10 Tf 100 708 Td (6:00AM) Tj ET\n" +
    "BT /F1 10 Tf 200 708 Td (6:10AM) Tj ET\n" +
    "BT /F1 10 Tf 300 708 Td (6:20AM) Tj ET\n";
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const off of offsets) {
    body += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  body +=
    `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

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

async function pdfToItems(buf: Buffer) {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await mod.getDocument({ data: new Uint8Array(buf) } as Parameters<
    typeof mod.getDocument
  >[0]).promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const items: Array<{ str: string; transform: number[] }> = [];
    for (const it of content.items) {
      if (typeof (it as { str?: unknown }).str !== "string") continue;
      const ti = it as { str: string; transform: number[] };
      if (!ti.str.trim()) continue; // Filter out whitespace-only items
      items.push({ str: ti.str, transform: ti.transform });
    }
    return items;
  } finally {
    await doc.destroy();
  }
}

test("stacked-cell PDF: pdfjs → serializer pairs date+time per cell", async () => {
  const buf = buildStackedCellPdf();
  const items = await pdfToItems(buf);
  // Sanity: pdfjs actually picked up our six text objects.
  // pdfjs interleaves whitespace " " spacer glyphs between real
  // tokens — that's normal for any real PDF. We just need at least
  // the 6 real tokens to be present.
  const real = items.filter((it) => it.str.trim() !== "");
  assert.equal(real.length, 6, "pdfjs should extract all 6 real tokens");

  const out = serializePdfTextItems(items);
  // Each date must land on the same logical line as the time
  // directly beneath it, in column order.
  assert.match(out, /05\/10\s+6:00AM/);
  assert.match(out, /05\/11\s+6:10AM/);
  assert.match(out, /05\/12\s+6:20AM/);
  // And the whole document must collapse to a SINGLE line — the
  // merge fired, dates and times aren't on separate y-band lines.
  assert.equal(
    out.split("\n").length,
    1,
    `expected one merged line, got:\n${out}`,
  );
});

test("stacked-cell PDF: new serializer differs from legacy (proves the merge fires)", async () => {
  const buf = buildStackedCellPdf();
  const items = await pdfToItems(buf);
  const legacy = legacySerialize(items);
  const next = serializePdfTextItems(items);
  // Legacy would emit two y-band lines (all dates, then all times).
  // The merge must produce a different shape.
  assert.notEqual(
    next,
    legacy,
    "serializer output must diverge from legacy on stacked-cell PDFs " +
      "(otherwise the merge isn't firing)",
  );
  assert.equal(
    legacy.split("\n").length,
    2,
    "sanity: legacy serializer should produce two lines for this fixture",
  );
});
