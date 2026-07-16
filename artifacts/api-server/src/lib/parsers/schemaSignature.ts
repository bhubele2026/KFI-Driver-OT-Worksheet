import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

/**
 * Return the first row of a worksheet that has at least one non-blank
 * string cell. Some vendor exports prefix the real header row with a
 * blank or title row, so callers can't assume row 0.
 */
function firstNonEmptyRow(ws: XLSX.WorkSheet): unknown[] | undefined {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
  });
  for (const r of rows) {
    if (
      Array.isArray(r) &&
      r.some((c) => c != null && String(c).trim() !== "")
    ) {
      return r;
    }
  }
  return undefined;
}

/**
 * Resolve a customer's `sheetSelector` import-rule to a concrete sheet
 * name in `wb`. Shared by the signature, the layout recorder, and the
 * generic reader so all three operate on the SAME sheet for a multi-sheet
 * workbook (e.g. Orgill ships a "Master External" Zenople export as sheet
 * 1 and the real timecard as another sheet). Resolution order:
 *   1. no selector → first sheet (the historical default).
 *   2. exact case-insensitive match on a sheet name.
 *   3. numeric selector → 1-based sheet index.
 *   4. best header-token overlap: the sheet whose header row shares the
 *      most words with the selector string. Run BEFORE substring so a
 *      prose selector like "…Employee ID / … / Total, NOT the Master
 *      External export…" picks the timecard sheet by its content rather
 *      than substring-matching the "Master External" sheet name it names
 *      only to EXCLUDE it.
 *   5. substring match on a sheet name (handles a short tab-name selector
 *      like "timecard" whose word doesn't appear in any header row).
 *   6. fallback → first sheet.
 */
export function resolveSheetName(
  wb: XLSX.WorkBook,
  sheetSelector?: string | null,
): string | undefined {
  const names = wb.SheetNames;
  if (names.length === 0) return undefined;
  const sel = (sheetSelector ?? "").trim();
  if (!sel) return names[0];

  const selLower = sel.toLowerCase();
  // 2. exact
  const exact = names.find((n) => n.toLowerCase() === selLower);
  if (exact) return exact;
  // 3. numeric (1-based)
  if (/^\d+$/.test(sel)) {
    const idx = Number(sel) - 1;
    if (idx >= 0 && idx < names.length) return names[idx];
  }
  // 4. best header-token overlap (before substring — a prose selector may
  //    mention the sheet to AVOID by name, which substring would wrongly
  //    latch onto; header content is the reliable signal).
  const selTokens = new Set(
    selLower.split(/[^a-z0-9]+/).filter((t) => t.length > 1),
  );
  if (selTokens.size > 0) {
    let bestName: string | undefined;
    let bestScore = 0;
    for (const name of names) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const header = firstNonEmptyRow(ws);
      if (!header) continue;
      const headerTokens = new Set(
        header
          .flatMap((c) =>
            c == null ? [] : String(c).toLowerCase().split(/[^a-z0-9]+/),
          )
          .filter((t) => t.length > 1),
      );
      let score = 0;
      for (const t of selTokens) if (headerTokens.has(t)) score++;
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    if (bestName) return bestName;
  }
  // 5. substring (either direction — selector may be a fragment of the tab
  //    name, or a short tab name a fragment of the selector)
  const substr = names.find(
    (n) =>
      n.toLowerCase().includes(selLower) ||
      selLower.includes(n.toLowerCase()),
  );
  if (substr) return substr;
  // 6. fallback
  return names[0];
}

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
  sheetSelector?: string | null,
): Promise<string | null> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return computeXlsxSignature(buffer, sheetSelector);
  }
  if (lower.endsWith(".pdf")) {
    return computePdfSignature(buffer);
  }
  return null;
}

function computeXlsxSignature(
  buffer: Buffer,
  sheetSelector?: string | null,
): string | null {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    return null;
  }
  // Honor the customer's sheetSelector so a multi-sheet workbook signs on
  // the SAME sheet the recorder/reader will use (not always sheet 1).
  const sheetName = resolveSheetName(wb, sheetSelector);
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;

  const headerRow = firstNonEmptyRow(ws);
  if (!headerRow) return null;

  // Normalize each header cell (trim, lowercase, collapse whitespace)
  // and DROP empty cells before sorting alphabetically. The sort is the
  // key resilience step: vendors routinely shuffle column order
  // week-to-week (e.g. swap "Hours" and "Date" positions, append a new
  // "Cost Center" column) without actually changing the data shape. The
  // generic role reader matches roles by column NAME via the cached
  // `columnRoles` map, not by column index, so order is irrelevant to
  // whether the cached recipe still works — sorting here just keeps the
  // signature stable against those cosmetic shuffles. Empty-cell drop
  // similarly protects against a vendor adding/removing a blank
  // separator column between data columns.
  const cells = headerRow
    .map((c) =>
      c == null
        ? ""
        : String(c).trim().toLowerCase().replace(/\s+/g, " "),
    )
    .filter((c) => c.length > 0)
    .sort();
  if (cells.length === 0) return null;
  const norm = cells.join("|");
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
