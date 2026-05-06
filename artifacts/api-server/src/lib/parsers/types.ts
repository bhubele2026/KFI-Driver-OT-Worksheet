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

export interface ParseResult {
  customer: string;
  punches: ParsedPunch[];
  /**
   * Badge / employee IDs that appeared in the uploaded file but could not be
   * mapped to a known KFI driver (either no embedded mapping entry, or the
   * mapped kfiId is not in the active roster). Surfaced to the dispatcher so
   * a new hire's punches don't silently disappear from payroll.
   */
  unmappedIds: string[];
}
