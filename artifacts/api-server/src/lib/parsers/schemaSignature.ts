import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

/**
 * Compute a stable signature for a customer upload's column layout.
 *
 * Goal: identical files (same vendor's weekly export with the same column
 * headers, regardless of the actual punch data) hash to the same string,
 * so the per-row uploader can look up a cached parser strategy without
 * re-running AI extraction every week.
 *
 * Strategy:
 *  - For xlsx: read the first sheet's first non-empty row, normalize each
 *    header cell (trim, lowercase, collapse whitespace), join with `|`,
 *    and SHA-256.
 *  - For pdf (Task #257): extract page-1 text via pdfjs, strip values
 *    that vary per upload (numbers, dates, times, ALL-CAPS / Title-Case
 *    name runs), normalize whitespace, and SHA-256. The remaining text
 *    is the document's "structural skeleton" — column labels, fixed
 *    headers, watermark text — which stays stable week-to-week for the
 *    same vendor's template.
 *  - For image / anything else: return `null`. The route treats `null`
 *    as "no signature available — use the customer-level `'*'` fallback
 *    if present, otherwise AI".
 *
 * Empty / unreadable inputs also return `null` so the route falls
 * through to AI instead of caching nonsense under an empty signature.
 *
 * Async (was sync before Task #257) because PDF text extraction needs
 * pdfjs. xlsx callers see no behavior change.
 */
export async function computeHeaderSignature(
  fileName: string,
  buffer: Buffer,
): Promise<string | null> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return computeXlsxSignature(buffer);
  }
  if (lower.endsWith(".pdf")) {
    return computePdfSignature(buffer);
  }
  return null;
}

function computeXlsxSignature(buffer: Buffer): string | null {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    return null;
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;

  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
  });
  // Find the first row that has at least one non-blank string cell — some
  // exports prefix the actual header row with a blank or title row.
  let headerRow: unknown[] | undefined;
  for (const r of rows) {
    if (
      Array.isArray(r) &&
      r.some((c) => c != null && String(c).trim() !== "")
    ) {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) return null;

  const norm = headerRow
    .map((c) =>
      c == null
        ? ""
        : String(c).trim().toLowerCase().replace(/\s+/g, " "),
    )
    .join("|");
  if (!norm.replace(/\|/g, "")) return null;
  return createHash("sha256").update(norm).digest("hex");
}

/**
 * Build a stable layout fingerprint for a PDF. We use page 1 only —
 * later pages are typically just more employee data with the same
 * structure. We aggressively strip *values* (badges, names, dates,
 * times, currency, hours) leaving only the document's structural
 * scaffolding (column-header labels like "Employee", "ID", "Date",
 * "Time In", "Hours", plus any fixed report title text). The result
 * stays identical across weeks that use the same template, so the
 * second upload of e.g. an Adient PDF hashes to the same signature
 * as the first and hits the role cache.
 */
async function computePdfSignature(buffer: Buffer): Promise<string | null> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return null;
  }
  const data = new Uint8Array(buffer);
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    doc = await pdfjs.getDocument({
      data,
    } as Parameters<typeof pdfjs.getDocument>[0]).promise;
  } catch {
    return null;
  }
  try {
    if (doc.numPages === 0) return null;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) =>
        typeof (it as { str?: unknown }).str === "string"
          ? (it as { str: string }).str
          : "",
      )
      .join(" ");
    if (!text.trim()) return null;
    const normalized = normalizePdfTextForSignature(text);
    if (!normalized) return null;
    return createHash("sha256").update(normalized).digest("hex");
  } catch {
    return null;
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * Strip variable data from PDF page-1 text so different weeks of the
 * same template normalize to the same string. Exposed for testing.
 *
 * Order matters: dates and times before bare numbers, ALL-CAPS name
 * runs before Title-Case runs (so "BAILEY, R." gets caught by the
 * caps pattern before stray bits get eaten by the title-case rule).
 */
export function normalizePdfTextForSignature(text: string): string {
  return text
    .replace(/\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M/gi, "T") // times
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, "D") // iso dates
    .replace(
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(?:,\s*\d{4})?/gi,
      "D",
    )
    .replace(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, "D") // m/d[/y]
    .replace(/\$\s*\d[\d,]*\.?\d*/g, "M") // currency
    // Alphanumeric badge-like tokens (TELD9001, ABC123, 1234A) BEFORE
    // the bare-number rule so we don't strip "TELD" then leave "9001".
    .replace(/\b[A-Za-z]*\d+[A-Za-z0-9]*\b/g, "B")
    .replace(/\b\d+(?:\.\d+)?\b/g, "N") // bare numbers (defensive)
    // ALL-CAPS name runs ("BAILEY", "OTHER"), allowing trailing commas
    // and initials ("BAILEY, R.").
    .replace(/\b[A-Z][A-Z]+\b(?:[,\s]+[A-Z]\.?)*/g, "X")
    .replace(/\b[A-Z][a-z]+(?:\s+[A-Z]\.?)+/g, "X") // "John D." / "John Doe"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Helper for the AI-schema recorder & generic PDF role reader: extract
 * every page's lines (y-grouped, x-sorted) from a PDF buffer. Returns
 * `null` if the PDF can't be opened or has no extractable text (which
 * is the same signal the legacy PDF parsers use to fall back to OCR /
 * AI). Keep this in sync with `pageLines` in `pdf.ts`.
 */
export async function extractPdfLinesByPage(
  buffer: Buffer,
): Promise<string[][] | null> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return null;
  }
  const data = new Uint8Array(buffer);
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    doc = await pdfjs.getDocument({
      data,
    } as Parameters<typeof pdfjs.getDocument>[0]).promise;
  } catch {
    return null;
  }
  try {
    const out: string[][] = [];
    let totalLines = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = new Map<number, Array<{ x: number; text: string }>>();
      for (const item of content.items) {
        if (typeof (item as { str?: unknown }).str !== "string") continue;
        const it = item as { str: string; transform: number[] };
        const y = Math.round(it.transform[5]);
        const arr = rows.get(y) ?? [];
        arr.push({ x: it.transform[4], text: it.str.trim() });
        rows.set(y, arr);
      }
      const lines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) =>
          items
            .sort((a, b) => a.x - b.x)
            .map((i) => i.text)
            .filter((t) => t.length > 0)
            .join(" "),
        );
      totalLines += lines.length;
      out.push(lines);
    }
    if (totalLines === 0) return null;
    return out;
  } catch {
    return null;
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
}
