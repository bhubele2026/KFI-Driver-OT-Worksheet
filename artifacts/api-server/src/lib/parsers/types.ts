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
}
