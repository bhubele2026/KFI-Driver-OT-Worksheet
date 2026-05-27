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
  /**
   * Driver name as it appeared on the source row, when the extractor saw one
   * (AI's `driverNameOnDoc`). Optional and only consumed by post-extraction
   * tooling — currently the xlsx schema-cache recorder, which uses it as a
   * search needle to locate the name column in the workbook so the cached
   * recipe can carry the name through on subsequent uploads (Task #338). Not
   * persisted, not returned to the dispatcher; safe to leave undefined.
   */
  nameOnDoc?: string | null;
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
   * Deprecated (Task #308). Always `false` / `0` now that the NDJSON
   * pipeline either fully recovers a chunk via targeted re-issue or
   * throws — there is no partial-extraction state to surface. The
   * fields stay on the type (and on the OpenAPI contract) for one
   * release to avoid forcing a coordinated UI bump.
   */
  extractionTruncated?: boolean;
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
  /**
   * Task #427: per-row drop diagnostics. Every row the extractor saw but
   * could not turn into a punch (and that isn't already surfaced via
   * `unmappedIds` or `pendingNamedRows`) lands here with a typed
   * `reason`, an optional human-readable `detail`, and a snapshot of
   * whatever raw fields the extractor could see. Surfaced to the chat
   * via `read_upload_file_rows` so Claude can explain WHY a row failed
   * to land instead of asking the dispatcher.
   */
  droppedRows?: DroppedRow[];
}

/**
 * Task #427: bucketed reasons a row the extractor saw never landed
 * as a punch.
 *
 * - `no_driver_match` — badge / employee id not in roster and no
 *   alias maps it to a known KFI driver.
 * - `not_a_driver_alias` — name-on-doc maps to the sentinel "not a
 *   driver" alias (the dispatcher explicitly told us to ignore it).
 * - `outside_week` — the parsed date fell outside the requested
 *   payroll-week window.
 * - `duplicate_collapsed` — folded into another row by the AI-lane
 *   pay-category dedupe.
 * - `extraction_failed` — parser saw a row but couldn't read it
 *   (malformed date, missing clock times, schema mismatch).
 * - `unknown` — residual / gap-inferred drop with no other bucket
 *   match. Reserved for genuine "we have no idea" so the chat can
 *   spot real blind spots.
 */
export type DroppedRowReason =
  | "no_driver_match"
  | "not_a_driver_alias"
  | "outside_week"
  | "duplicate_collapsed"
  | "extraction_failed"
  | "unknown";

/**
 * Snapshot of a row the extractor saw but dropped. Field shape is
 * intentionally the same as a pending-named row so the UI / chat can
 * render them with one renderer. Every field is optional because
 * different drop sites have different visibility into the raw row
 * (e.g. an outside-week row in the AI lane has every field; a
 * gap-inferred `unknown` drop may have none).
 */
export interface DroppedRow {
  reason: DroppedRowReason;
  /** Human-readable nuance, e.g. "badge 2004792 not in roster". */
  detail: string | null;
  rawRow: {
    driverNameOnDoc: string | null;
    badgeOrId: string | null;
    date: string | null;
    timeIn: string | null;
    timeOut: string | null;
    hours: number | null;
  };
}

/**
 * Tiny collector parsers thread through their row loop. `add` keeps
 * one entry per (reason, raw-row-identity) pair so a runaway loop
 * doesn't blow up the JSON payload.
 */
export class DroppedRowAccumulator {
  private rows = new Map<string, DroppedRow>();

  add(entry: DroppedRow): void {
    const r = entry.rawRow;
    const key = [
      entry.reason,
      r.driverNameOnDoc ?? "",
      r.badgeOrId ?? "",
      r.date ?? "",
      r.timeIn ?? "",
      r.timeOut ?? "",
    ].join("|");
    if (!this.rows.has(key)) this.rows.set(key, entry);
  }

  toArray(): DroppedRow[] {
    return [...this.rows.values()];
  }
}
