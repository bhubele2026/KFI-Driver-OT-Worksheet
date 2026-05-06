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
}
