export interface ParsedPunch {
  kfiId: string;
  customer: string;
  date: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  payType: "Reg" | "OT";
  /** Set true for IWG (already in EST display tz, no further conversion). */
  noTz?: boolean;
  /**
   * Raw badge / employee id as it appeared in the source file, when the
   * extractor saw one (AI's `badgeOrId`, parsers reading badge columns).
   * Optional and only consumed by post-extraction tooling — currently the
   * PDF schema-cache recorder, which uses it as a search needle to locate
   * the originating line in the document so it can derive a stable
   * employee-anchor regex for the cache. Not persisted, not returned to
   * the dispatcher; safe to leave undefined.
   */
  rawBadge?: string | null;
}

export interface UnmappedIdEntry {
  /** The raw external id as it appeared in the file (badge #, TELD code, employee number). */
  id: string;
  /** Number of rows in the file that referenced this id and got dropped. */
  count: number;
  /**
   * Driver name as it appeared on the row when the parser could see it
   * (e.g. Adient's "LAST, FIRST (TELDxxx)" header, IWG's "Employee: ..." line).
   * Null when the format doesn't carry a name near the id. Used to pre-fill
   * the admin "Add driver-id mapping" form so an admin can recognize who the
   * id belongs to without opening the source file.
   */
  sampleName: string | null;
}

/**
 * Collector handed to every parser. Parsers call `add(id, sampleName?)` for
 * each row they had to drop because the id was unknown. Multiple calls for
 * the same id increment the count; the first non-null sample name wins.
 */
export class UnmappedIdAccumulator {
  private rows = new Map<string, { count: number; sampleName: string | null }>();

  add(id: string, sampleName?: string | null): void {
    const trimmed = id.trim();
    if (!trimmed) return;
    const cleanName =
      typeof sampleName === "string" && sampleName.trim().length > 0
        ? sampleName.trim()
        : null;
    const existing = this.rows.get(trimmed);
    if (existing) {
      existing.count += 1;
      if (!existing.sampleName && cleanName) existing.sampleName = cleanName;
    } else {
      this.rows.set(trimmed, { count: 1, sampleName: cleanName });
    }
  }

  toArray(): UnmappedIdEntry[] {
    return [...this.rows.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, v]) => ({ id, count: v.count, sampleName: v.sampleName }));
  }
}

/**
 * Bucketed counts of every row the AI extractor saw vs. accepted. Surfaced
 * to the dispatcher so a "0 punches" outcome is explained ("AI read 47 rows;
 * 38 had driver names we couldn't match to your roster") instead of silent.
 * Only populated by the AI extract path — deterministic parsers don't expose
 * these counts because the parser-specific shape is already explained by
 * `unmappedIds` alone.
 */
export interface ExtractDiagnostics {
  /** Total rows the model returned for this file. */
  rawRowCount: number;
  /** Rows dropped because the `date` field could not be normalized to YYYY-MM-DD. */
  invalidDateCount: number;
  /** Rows whose normalized date fell outside the requested week window. */
  outOfWindowCount: number;
  /** Rows whose driver name / badge couldn't be resolved to a known KFI driver. */
  unmappedDriverCount: number;
  /** Rows dropped because clock in / out / hours were missing or non-positive. */
  invalidTimeCount: number;
  /** Rows that made it through and became persisted punches. */
  acceptedCount: number;
  /**
   * True when at least one Gemini response was truncated at the
   * `maxOutputTokens` cap and salvage recovered only the rows that fit.
   * Task #264. Even after auto-chunking + halving retries, an extremely
   * dense workbook can still bust the cap; the route surfaces this flag
   * to the dispatcher so they know the preview may be missing rows.
   */
  extractionTruncated?: boolean;
  /**
   * Number of chunks (in the chunked xlsx path) whose Gemini call threw
   * or timed out and were skipped instead of failing the whole upload.
   * Task #267. Non-zero implies `extractionTruncated: true` (some rows
   * are missing) and triggers a stronger preview-dialog banner so the
   * dispatcher knows the preview is incomplete and can re-upload the
   * file split into smaller parts if the row count looks wrong. Absent
   * / 0 on single-call paths (images, PDFs, small xlsx) since those
   * have no per-chunk fan-out to partially fail.
   */
  failedChunks?: number;
}

/**
 * AI rows the extractor could NOT resolve to a kfiId before stash time.
 * Re-imported from the schema package so server code that builds a
 * ParseResult doesn't have to depend on @workspace/db directly.
 */
export interface PendingNamedRowOut {
  driverNameOnDoc: string;
  badgeOrId: string | null;
  date: string;
  timeIn: string | null;
  timeOut: string | null;
  hours: number | null;
}

export interface ParseResult {
  customer: string;
  punches: ParsedPunch[];
  /**
   * Badge / employee IDs that appeared in the uploaded file but could not be
   * mapped to a known KFI driver (either no embedded mapping entry, or the
   * mapped kfiId is not in the active roster). Surfaced to the dispatcher so
   * a new hire's punches don't silently disappear from payroll.
   */
  unmappedIds: UnmappedIdEntry[];
  /** Set by the AI extract path; absent for deterministic parsers. */
  diagnostics?: ExtractDiagnostics;
  /**
   * AI-only: rows that came back from the model but couldn't be resolved to
   * a kfiId (no badge match, no name alias, fuzzy below threshold). The
   * confirm route stashes these so it can re-resolve them after the
   * dispatcher picks drivers in the preview dialog. Absent for deterministic
   * parsers (which don't see un-resolvable name rows — only un-resolvable
   * badge IDs, which are already in `unmappedIds`).
   */
  pendingNamedRows?: PendingNamedRowOut[];
}
