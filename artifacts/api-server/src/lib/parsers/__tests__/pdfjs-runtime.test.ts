import { test } from "node:test";
import assert from "node:assert/strict";

// Regression guard for the pdfjs-dist v5 upgrade trap (task #134 / #149).
//
// pdfjs-dist v5+ pulled in browser-only globals (`DOMMatrix`, `Path2D`,
// `ImageData`) at the top of its legacy build, which crashes Node the moment
// you call `getDocument(...).promise` — every PDF upload would fail with
// "DOMMatrix is not defined" before any of the customer fixtures even get a
// chance to run. We pinned `pdfjs-dist` back to `^4.10.38` in
// `artifacts/api-server/package.json`; this test exists so a future bump
// (Renovate, manual, transitive) fails fast in <1s instead of waiting for the
// slow DeLallo OCR fixture to flag it in production.
//
// Keep this test buffer-only: no network, no Gemini, no real customer files.

function buildTinyPdfBuffer(): Buffer {
  // Hand-rolled minimal single-page PDF with one text object ("hi"). This
  // avoids pulling in pdfkit/fonts just to exercise pdfjs's parse path, and
  // keeps the whole test well under a second.
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    "4 0 obj << /Length 44 >>\nstream\nBT /F1 24 Tf 72 720 Td (hi) Tj ET\nendstream\nendobj\n",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body +=
    `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const BROWSER_GLOBAL_PATTERN = /(DOMMatrix|Path2D|ImageData)\b.*not defined/i;

test("pdfjs-dist loads and parses a PDF in Node without browser-only globals", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buildTinyPdfBuffer());

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | undefined;
  try {
    doc = await pdfjs
      .getDocument({ data } as Parameters<typeof pdfjs.getDocument>[0])
      .promise;
    assert.equal(doc.numPages, 1, "expected the tiny fixture to have 1 page");
    const page = await doc.getPage(1);
    // getTextContent is the exact entry point every customer PDF parser hits
    // (see lib/parsers/pdf.ts#pageLines). If pdfjs needs DOMMatrix/Path2D/
    // ImageData on this path, this is where v5 blows up.
    const content = await page.getTextContent();
    assert.ok(Array.isArray(content.items), "getTextContent returned items");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.doesNotMatch(
      msg,
      BROWSER_GLOBAL_PATTERN,
      `pdfjs-dist tried to use a browser-only global in Node — did pdfjs-dist get bumped past v4? See artifacts/api-server/package.json. Original error: ${msg}`,
    );
    throw err;
  } finally {
    await doc?.destroy();
  }
});
