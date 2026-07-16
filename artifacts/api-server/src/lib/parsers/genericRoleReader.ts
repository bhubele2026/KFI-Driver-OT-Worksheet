import * as XLSX from "xlsx";
import { UnmappedIdAccumulator, DroppedRowAccumulator } from "./types.js";
import type { DroppedRow, ParseResult, ParsedPunch } from "./types.js";
import { extractPdfLinesByPage } from "./schemaSignature.js";
import { isBadgeMatchTrustworthy } from "./fuzzy.js";

/**
 * Task #363: optional collision-guard context the readers use to
 * refuse a bare badge → kfi match when the matched driver isn't on
 * the uploaded customer's roster (and no name alias / name agreement
 * vouches for the pairing). Callers in production pass both; tests
 * that don't care can omit the bag and the legacy permissive
 * behaviour returns.
 */
export interface BadgeGuardContext {
  uploadedCustomer: string;
  driversByKfi: ReadonlyMap<string, { name: string; customer: string | null }>;
  nameAliasMap?: ReadonlyMap<string, string> | null;
}

export interface ColumnRoles {
  badge: number;
  date: number;
  timeIn: number;
  timeOut: number;
  hours?: number | null;
  /**
   * Index of the column carrying the driver name on the source row, when
   * the AI run that recorded the recipe was able to locate one (Task #338).
   * Optional: older cached recipes written before this field existed will
   * be missing it, and the reader must tolerate that — in that case the
   * unmapped panel falls back to "(no name on doc)" until the next
   * successful AI re-run for the customer rewrites the recipe with the
   * column included.
   */
  name?: number | null;
  /**
   * Name of the workbook sheet these roles were inferred from, when the
   * recorder pinned a specific sheet (multi-sheet workbooks — e.g. Orgill's
   * timecard sheet, not its "Master External" export). Optional: older
   * recipes written before this field, and single-sheet files, leave it
   * unset and the reader falls back to the first sheet.
   */
  sheet?: string | null;
}

function isColumnRoles(v: unknown): v is ColumnRoles {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.badge === "number" &&
    typeof r.date === "number" &&
    typeof r.timeIn === "number" &&
    typeof r.timeOut === "number"
  );
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function normalizeDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function normalizeTime(v: unknown, dateIso: string): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const h = v.getUTCHours();
    const min = v.getUTCMinutes();
    const ampm = h < 12 ? "AM" : "PM";
    const hr12 = h % 12 === 0 ? 12 : h % 12;
    return `${dateIso} ${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
  }
  const s = String(v).trim();
  if (!s) return null;
  // "H:MM AM/PM" or "HH:MM"
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const tag = m[3]?.toUpperCase();
  if (tag) {
    return `${dateIso} ${h}:${String(min).padStart(2, "0")} ${tag}`;
  }
  const ampm = h < 12 ? "AM" : "PM";
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${dateIso} ${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
}

function diffHours(clockIn: string, clockOut: string): number {
  const parse = (s: string) => {
    const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}) (AM|PM)$/);
    if (!m) return NaN;
    let h = parseInt(m[2]);
    const min = parseInt(m[3]);
    if (m[4] === "PM" && h !== 12) h += 12;
    if (m[4] === "AM" && h === 12) h = 0;
    return Date.UTC(
      parseInt(m[1].slice(0, 4)),
      parseInt(m[1].slice(5, 7)) - 1,
      parseInt(m[1].slice(8, 10)),
      h,
      min,
    );
  };
  const a = parse(clockIn);
  const b = parse(clockOut);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round(((b - a) / 36e5) * 100) / 100;
}

/**
 * Read an xlsx using AI-discovered column roles. Used by the per-row
 * upload pipeline's `cache` branch in `/extract-customer-file`: when a
 * prior successful AI extraction wrote `column_roles` for the file's
 * header signature, subsequent uploads with the same layout skip AI
 * and use this reader instead.
 *
 * Returns null if the role shape is malformed or the workbook is
 * unreadable — caller falls through to AI in that case.
 */
export function readWithRoles(
  customer: string,
  buffer: Buffer,
  columnRoles: unknown,
  kfiSet: Set<string>,
  idMap: Record<string, string>,
  weekStart: string,
  weekEnd: string,
  badgeGuard?: BadgeGuardContext,
): ParseResult | null {
  if (!isColumnRoles(columnRoles)) return null;
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    return null;
  }
  // Open the sheet the recorder pinned these roles to (multi-sheet
  // workbooks), falling back to the first sheet for older single-sheet
  // recipes that never stored a sheet name.
  const sheetName =
    (columnRoles.sheet && wb.SheetNames.includes(columnRoles.sheet)
      ? columnRoles.sheet
      : undefined) ?? wb.SheetNames[0];
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
  });
  const unmapped = new UnmappedIdAccumulator();
  const dropped = new DroppedRowAccumulator();
  const punches: ParsedPunch[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const rawBadge = cellToString(row[columnRoles.badge]);
    if (!rawBadge) continue;
    // Read any name early so a drop entry can carry it as context.
    let sampleName: string | null = null;
    if (columnRoles.name != null) {
      const raw = cellToString(row[columnRoles.name]).trim();
      if (raw) sampleName = raw;
    }
    const earlyName = sampleName;
    const rawDateCell = row[columnRoles.date];
    const rawInCell = row[columnRoles.timeIn];
    const rawOutCell = row[columnRoles.timeOut];
    const dateIso = normalizeDate(rawDateCell);
    if (!dateIso) {
      dropped.add({
        reason: "extraction_failed",
        detail: `unparseable date cell ${JSON.stringify(rawDateCell ?? null)}`,
        rawRow: {
          driverNameOnDoc: earlyName,
          badgeOrId: rawBadge,
          date: rawDateCell == null ? null : String(rawDateCell),
          timeIn: rawInCell == null ? null : String(rawInCell),
          timeOut: rawOutCell == null ? null : String(rawOutCell),
          hours: null,
        },
      });
      continue;
    }
    if (dateIso < weekStart || dateIso > weekEnd) {
      dropped.add({
        reason: "outside_week",
        detail: `date ${dateIso} is outside ${weekStart}..${weekEnd}`,
        rawRow: {
          driverNameOnDoc: earlyName,
          badgeOrId: rawBadge,
          date: dateIso,
          timeIn: rawInCell == null ? null : String(rawInCell),
          timeOut: rawOutCell == null ? null : String(rawOutCell),
          hours: null,
        },
      });
      continue;
    }
    const clockIn = normalizeTime(rawInCell, dateIso);
    const clockOut = normalizeTime(rawOutCell, dateIso);
    if (!clockIn || !clockOut) {
      dropped.add({
        reason: "extraction_failed",
        detail: !clockIn && !clockOut
          ? "missing both clock-in and clock-out"
          : !clockIn
            ? "missing or unparseable clock-in"
            : "missing or unparseable clock-out",
        rawRow: {
          driverNameOnDoc: earlyName,
          badgeOrId: rawBadge,
          date: dateIso,
          timeIn: rawInCell == null ? null : String(rawInCell),
          timeOut: rawOutCell == null ? null : String(rawOutCell),
          hours: null,
        },
      });
      continue;
    }
    // Resolve badge → kfiId. Aliases take precedence (a customer's
    // external employee number remapped to a KFI driver); otherwise
    // fall through to the badge itself if it's already a real
    // kfi_id (matches the AI path in `imageSupport.resolveKfiId`,
    // which accepts kfiSet.has(badge) as a self-mapping so files
    // that ship driver kfi_ids in the badge column don't need a
    // dummy alias per driver).
    // sampleName already read above so a drop entry can carry it.
    const aliased = idMap[rawBadge];
    let mapped: string | null = null;
    if (aliased && kfiSet.has(aliased)) mapped = aliased;
    else if (kfiSet.has(rawBadge)) mapped = rawBadge;
    // Task #363: when the cached recipe self-resolves a numeric
    // employee number to a real KFI badge (e.g. Trienda's "Employee
    // Number" column accidentally matching Felix Baez Caballero's
    // badge), refuse the match unless corroborated by roster /
    // alias / name agreement. Older callers without the guard
    // context retain the previous permissive behaviour.
    if (
      mapped &&
      badgeGuard &&
      !isBadgeMatchTrustworthy({
        candidateKfiId: mapped,
        nameOnDoc: sampleName ?? "",
        uploadedCustomer: badgeGuard.uploadedCustomer,
        driversByKfi: badgeGuard.driversByKfi,
        nameAliasMap: badgeGuard.nameAliasMap,
      })
    ) {
      mapped = null;
    }
    if (!mapped) {
      unmapped.add(rawBadge, sampleName);
      dropped.add({
        reason: "no_driver_match",
        detail: `badge ${rawBadge} not in roster${
          sampleName ? ` (name on doc: ${sampleName})` : ""
        }`,
        rawRow: {
          driverNameOnDoc: sampleName,
          badgeOrId: rawBadge,
          date: dateIso,
          timeIn: clockIn,
          timeOut: clockOut,
          hours: null,
        },
      });
      continue;
    }
    let hours: number | null = null;
    if (columnRoles.hours != null && row[columnRoles.hours] != null) {
      const h = Number(row[columnRoles.hours]);
      if (!isNaN(h) && h > 0) hours = Math.round(h * 100) / 100;
    }
    if (hours == null) hours = diffHours(clockIn, clockOut);
    if (hours != null && hours > 20) {
      // Implausible single shift — almost certainly a daily/weekly TOTAL row,
      // not a punch (e.g. Landscape Structures' per-day total). Drop it.
      dropped.add({
        reason: "extraction_failed",
        detail: `implausible shift hours ${hours} > 20 (likely a total row)`,
        rawRow: {
          driverNameOnDoc: earlyName,
          badgeOrId: rawBadge,
          date: dateIso,
          timeIn: clockIn,
          timeOut: clockOut,
          hours,
        },
      });
      continue;
    }
    if (hours <= 0) {
      dropped.add({
        reason: "extraction_failed",
        detail: `computed hours <= 0 (clockIn=${clockIn}, clockOut=${clockOut})`,
        rawRow: {
          driverNameOnDoc: earlyName,
          badgeOrId: rawBadge,
          date: dateIso,
          timeIn: clockIn,
          timeOut: clockOut,
          hours,
        },
      });
      continue;
    }
    punches.push({
      kfiId: mapped,
      customer,
      date: dateIso,
      clockIn,
      clockOut,
      hours,
      payType: "Reg",
    });
  }
  return {
    customer,
    punches,
    unmappedIds: unmapped.toArray(),
    droppedRows: dropped.toArray(),
  };
}

/* ============================================================
 * PDF role reader (Task #257)
 *
 * Mirrors `readWithRoles` for PDFs. After a successful AI
 * extraction on a PDF, `recordAiSchemaIfPossible` infers two
 * regex templates:
 *   - `employeeAnchor`: matches a "new employee" line and
 *     captures the raw badge id in group 1.
 *   - `dataRow`: matches a per-punch line and captures the
 *     in-time (group 1) and out-time (group 2), optionally
 *     followed by hours (group 3).
 *
 * On subsequent uploads with the same PDF layout signature, the
 * route calls `readPdfWithRoles` instead of Gemini — the reader
 * walks each line, switches the current badge on anchor hits,
 * and emits punches on dataRow hits. Dates are extracted from
 * the same data line via a set of standard date regexes (ISO,
 * M/D, "May 12, 2026", "(05/12)" DeLallo-style); when no date
 * is on the data line itself, the reader looks back at the
 * previous 5 lines for the most recent date.
 *
 * Returns null on malformed roles or unreadable PDF (forces AI
 * re-run, which then overwrites the stale cache row).
 * ============================================================ */

export interface PdfColumnRoles {
  format: "pdf";
  employeeAnchor: { regex: string; flags?: string };
  dataRow: { regex: string; flags?: string };
  /** Year used to backfill dates that omit it (e.g. DeLallo "(05/12)"). */
  fallbackYear?: number;
}

function isPdfColumnRoles(v: unknown): v is PdfColumnRoles {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (r.format !== "pdf") return false;
  const a = r.employeeAnchor as { regex?: unknown } | undefined;
  const d = r.dataRow as { regex?: unknown } | undefined;
  return (
    typeof a?.regex === "string" &&
    typeof d?.regex === "string" &&
    a.regex.length > 0 &&
    d.regex.length > 0
  );
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Pull an ISO date out of a single PDF text line, trying the formats
 * we see across our PDF customers in priority order:
 *   - ISO `YYYY-MM-DD`
 *   - `Month Day, Year` (Adient)
 *   - `Month Day` with year supplied via `fallbackYear` (rare)
 *   - `M/D/YYYY` or `M/D/YY`
 *   - `(M/D)` with year supplied via `fallbackYear` (DeLallo)
 */
function findDateInLine(line: string, fallbackYear?: number): string | null {
  let m = line.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = line.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{1,2}),?\s*(\d{4})\b/i,
  );
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return `${m[3]}-${mo}-${m[2].padStart(2, "0")}`;
  }
  m = line.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = line.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m && fallbackYear) {
    return `${fallbackYear}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = line.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{1,2})\b/i,
  );
  if (m && fallbackYear) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return `${fallbackYear}-${mo}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function normalizeTimeStr(raw: string, dateIso: string): string | null {
  const m = raw
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const tag = m[3]?.toUpperCase();
  if (tag) {
    return `${dateIso} ${h}:${String(min).padStart(2, "0")} ${tag}`;
  }
  const ampm = h < 12 ? "AM" : "PM";
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${dateIso} ${hr12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/**
 * Read a PDF using AI-discovered employee-anchor and data-row regex
 * templates. See module header for protocol. Walks each page's lines
 * in order. Returns null only if the role shape is malformed or the
 * PDF is unreadable — the route falls through to AI in that case,
 * which will overwrite this cache row.
 */
export async function readPdfWithRoles(
  customer: string,
  buffer: Buffer,
  columnRoles: unknown,
  kfiSet: Set<string>,
  idMap: Record<string, string>,
  weekStart: string,
  weekEnd: string,
  badgeGuard?: BadgeGuardContext,
): Promise<ParseResult | null> {
  if (!isPdfColumnRoles(columnRoles)) return null;
  const pages = await extractPdfLinesByPage(buffer);
  if (!pages) return null;

  let employeeRe: RegExp;
  let dataRe: RegExp;
  try {
    employeeRe = new RegExp(
      columnRoles.employeeAnchor.regex,
      columnRoles.employeeAnchor.flags ?? "",
    );
    dataRe = new RegExp(
      columnRoles.dataRow.regex,
      columnRoles.dataRow.flags ?? "",
    );
  } catch {
    return null;
  }

  const unmapped = new UnmappedIdAccumulator();
  const dropped = new DroppedRowAccumulator();
  const punches: ParsedPunch[] = [];
  const fallbackYear =
    columnRoles.fallbackYear ?? parseInt(weekStart.slice(0, 4));

  for (const lines of pages) {
    let currentRawBadge: string | null = null;
    let currentKfiId: string | null = null;
    let currentSampleName: string | null = null;
    let currentMapped = false;
    let lastSeenDate: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const eMatch = employeeRe.exec(line);
      employeeRe.lastIndex = 0;
      // Prefer named captures (Task #341) so the recipe's textual
      // ordering of name vs badge doesn't matter; fall back to
      // positional group 1 (legacy badge-only recipes) and group 2
      // (rare positional name).
      const badgeRaw =
        (eMatch?.groups?.badge ?? eMatch?.[1] ?? "").trim();
      if (eMatch && badgeRaw) {
        currentRawBadge = badgeRaw;
        currentSampleName =
          (eMatch.groups?.name ?? eMatch[2] ?? "").trim() || null;
        const aliased = idMap[currentRawBadge];
        let mapped: string | null = null;
        if (aliased && kfiSet.has(aliased)) mapped = aliased;
        else if (kfiSet.has(currentRawBadge)) mapped = currentRawBadge;
        // Task #363 collision guard — mirror the xlsx cache reader so
        // a numeric employee number that happens to equal a real KFI
        // badge from a different customer doesn't auto-resolve.
        if (
          mapped &&
          badgeGuard &&
          !isBadgeMatchTrustworthy({
            candidateKfiId: mapped,
            nameOnDoc: currentSampleName ?? "",
            uploadedCustomer: badgeGuard.uploadedCustomer,
            driversByKfi: badgeGuard.driversByKfi,
            nameAliasMap: badgeGuard.nameAliasMap,
          })
        ) {
          mapped = null;
        }
        if (mapped) {
          currentKfiId = mapped;
          currentMapped = true;
        } else {
          currentKfiId = null;
          currentMapped = false;
          unmapped.add(currentRawBadge, currentSampleName);
          dropped.add({
            reason: "no_driver_match",
            detail: `badge ${currentRawBadge} not in roster${
              currentSampleName ? ` (name on doc: ${currentSampleName})` : ""
            }`,
            rawRow: {
              driverNameOnDoc: currentSampleName,
              badgeOrId: currentRawBadge,
              date: lastSeenDate,
              timeIn: null,
              timeOut: null,
              hours: null,
            },
          });
        }
        continue;
      }
      // Cheap date pre-scan so multi-line PDFs (date on its own line)
      // still know the current date when the punch line lands.
      const lineDate = findDateInLine(line, fallbackYear);
      if (lineDate) lastSeenDate = lineDate;

      if (!currentMapped || !currentKfiId) continue;

      const dMatch = dataRe.exec(line);
      dataRe.lastIndex = 0;
      if (!dMatch) continue;
      const inRaw = (dMatch[1] ?? "").trim();
      const outRaw = (dMatch[2] ?? "").trim();
      if (!inRaw || !outRaw) {
        dropped.add({
          reason: "extraction_failed",
          detail: "data row matched but in/out times empty",
          rawRow: {
            driverNameOnDoc: currentSampleName,
            badgeOrId: currentRawBadge,
            date: lineDate ?? lastSeenDate,
            timeIn: inRaw || null,
            timeOut: outRaw || null,
            hours: null,
          },
        });
        continue;
      }

      // Try date on this line first, otherwise the most recent line.
      const dateIso = lineDate ?? lastSeenDate;
      if (!dateIso) {
        dropped.add({
          reason: "extraction_failed",
          detail: "no date found on data row or any recent line",
          rawRow: {
            driverNameOnDoc: currentSampleName,
            badgeOrId: currentRawBadge,
            date: null,
            timeIn: inRaw,
            timeOut: outRaw,
            hours: null,
          },
        });
        continue;
      }
      if (dateIso < weekStart || dateIso > weekEnd) {
        dropped.add({
          reason: "outside_week",
          detail: `date ${dateIso} is outside ${weekStart}..${weekEnd}`,
          rawRow: {
            driverNameOnDoc: currentSampleName,
            badgeOrId: currentRawBadge,
            date: dateIso,
            timeIn: inRaw,
            timeOut: outRaw,
            hours: null,
          },
        });
        continue;
      }

      const clockIn = normalizeTimeStr(inRaw, dateIso);
      const clockOut = normalizeTimeStr(outRaw, dateIso);
      if (!clockIn || !clockOut) {
        dropped.add({
          reason: "extraction_failed",
          detail: "unparseable in/out time string",
          rawRow: {
            driverNameOnDoc: currentSampleName,
            badgeOrId: currentRawBadge,
            date: dateIso,
            timeIn: inRaw,
            timeOut: outRaw,
            hours: null,
          },
        });
        continue;
      }

      let hours: number | null = null;
      const hoursRaw = (dMatch[3] ?? "").trim();
      if (hoursRaw) {
        const h = parseFloat(hoursRaw);
        if (!isNaN(h) && h > 0 && h < 25) hours = Math.round(h * 100) / 100;
      }
      if (hours == null) hours = diffHours(clockIn, clockOut);
      if (!(hours > 0)) {
        dropped.add({
          reason: "extraction_failed",
          detail: `computed hours <= 0 (in=${clockIn}, out=${clockOut})`,
          rawRow: {
            driverNameOnDoc: currentSampleName,
            badgeOrId: currentRawBadge,
            date: dateIso,
            timeIn: clockIn,
            timeOut: clockOut,
            hours,
          },
        });
        continue;
      }

      punches.push({
        kfiId: currentKfiId,
        customer,
        date: dateIso,
        clockIn,
        clockOut,
        hours,
        payType: "Reg",
      });
    }
  }

  return {
    customer,
    punches,
    unmappedIds: unmapped.toArray(),
    droppedRows: dropped.toArray(),
  };
}
