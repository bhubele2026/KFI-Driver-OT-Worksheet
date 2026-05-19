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
 *  - For PDF / image / anything else: return `null`. The route treats
 *    `null` as "no signature available — use the customer-level `'*'`
 *    fallback if present, otherwise AI".
 *
 * Empty / zero-row sheets also return `null` so the route falls through
 * to AI instead of caching nonsense under an empty signature.
 */
export function computeHeaderSignature(
  fileName: string,
  buffer: Buffer,
): string | null {
  const lower = fileName.toLowerCase();
  const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");
  if (!isXlsx) return null;

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
