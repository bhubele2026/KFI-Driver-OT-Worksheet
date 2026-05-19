import * as XLSX from "xlsx";
import { Type } from "@google/genai";
import { logger } from "../logger.js";
import { getGeminiClient } from "./gemini.js";
import { toDisplayName } from "./displayName.js";

export interface AiExtractedRow {
  driverNameOnDoc: string;
  badgeOrId?: string | null;
  date: string; // YYYY-MM-DD
  timeIn?: string | null; // "H:MM AM/PM"
  timeOut?: string | null; // "H:MM AM/PM"
  hours?: number | null;
}

/**
 * Check if the given year, month, and day form a valid calendar date.
 * Prevents AI hallucinations like "2026-02-30".
 */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Coerce whatever shape Gemini returns in `date` into a strict YYYY-MM-DD
 * string. Gemini is asked for ISO dates in the prompt but routinely emits
 * `M/D/YYYY`, `MM/DD/YY`, `May 12, 2026`, ISO datetimes with timezones,
 * etc. The week-window filter downstream is a string compare, so anything
 * but YYYY-MM-DD silently drops 100% of the rows. Returns null when the
 * input genuinely can't be interpreted or is an impossible calendar date
 * (e.g. 2/30); callers count that into the `invalidDateCount` diagnostics bucket.
 */
/**
 * Reject impossible calendar dates like 2/30/2026 or 13/01/2026 that the
 * regex branches below would otherwise happily reformat to a valid-looking
 * YYYY-MM-DD string. The week-window filter downstream is a string compare
 * so an impossible date would survive — better to count it as
 * `invalidDateCount` than to silently include it.
 */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function normalizeIsoDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already YYYY-MM-DD (with or without trailing time/zone).
  let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!isRealCalendarDate(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // M/D/YYYY or MM/DD/YYYY (US-formatted).
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const y = parseInt(m[3], 10);
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (!isRealCalendarDate(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // M/D/YY (assume 2000s).
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const y = 2000 + parseInt(m[3], 10);
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (!isRealCalendarDate(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // Last resort: let the Date constructor try. Use the UTC slice to
  // avoid local-tz day flips for inputs like "May 12 2026". For non-ISO
  // strings the Date constructor silently rolls invalid dates (e.g.
  // "February 30, 2026" becomes March 2), so we cross-check the parsed
  // month/day against the original string to reject rollovers.
  const dt = new Date(trimmed);
  if (!isNaN(dt.getTime())) {
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const dy = dt.getUTCDate();
    if (!isRealCalendarDate(y, mo, dy)) return null;
    const months = [
      "jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    const lower = trimmed.toLowerCase();
    const monthIdx = dt.getUTCMonth();
    for (let i = 0; i < 12; i++) {
      if (lower.includes(months[i]) && i !== monthIdx) return null;
    }
    if (!trimmed.includes(String(dy))) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
  }
  return null;
}

const ROW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    rows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          driverNameOnDoc: { type: Type.STRING },
          badgeOrId: { type: Type.STRING },
          date: { type: Type.STRING },
          timeIn: { type: Type.STRING },
          timeOut: { type: Type.STRING },
          hours: { type: Type.NUMBER },
        },
        required: ["driverNameOnDoc", "date"],
      },
    },
  },
  required: ["rows"],
};

function xlsxToText(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const out: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    out.push(`# Sheet: ${name}`);
    out.push(XLSX.utils.sheet_to_csv(ws, { blankrows: false }));
  }
  return out.join("\n").slice(0, 200_000);
}

function buildPrompt(customer: string, weekStart: string, weekEnd: string) {
  return [
    `You are extracting timecard punches from a payroll export uploaded for customer "${customer}".`,
    `The week being reconciled is ${weekStart} through ${weekEnd} (Sunday through Saturday). Only return rows whose date falls in that window.`,
    `For each punch row return:`,
    `- driverNameOnDoc: the worker's name as written in the document (preserve casing exactly).`,
    `- badgeOrId: any employee/badge/payroll id shown for that worker (string of digits or alphanum), or omit.`,
    `- date: the punch date as YYYY-MM-DD. Resolve year from the week window if the document only shows MM/DD.`,
    `- timeIn / timeOut: clock in/out as "H:MM AM" or "H:MM PM". Omit if the document only shows total hours.`,
    `- hours: the daily worked hours as a decimal number when shown (e.g. 8.50). Omit if not present.`,
    `Return one row per shift per driver per date. Skip totals, summary, header, footer, and signature lines. Do not invent rows.`,
    `Return strictly JSON matching the provided schema.`,
  ].join("\n");
}

/**
 * Parse the model's JSON response, with a salvage path for truncated output.
 *
 * Gemini occasionally hits maxOutputTokens mid-row on very large weekly
 * exports, returning a JSON string that's missing its trailing brackets
 * (e.g. `{"rows":[{...},{"driverNameOnDoc":"Jo`). Rather than fail the
 * entire upload — which would force the dispatcher to manually enter ~150
 * punches — we trim back to the last complete row object in the `rows`
 * array and re-close the brackets. Any data after that point is lost, but
 * the dispatcher sees a partial preview they can confirm or re-run.
 */
/** Minimal logger shape — accepts req.log (pino child) or the module logger. */
type SalvageLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export function parseOrSalvage(
  raw: string,
  customer: string,
  fileName: string,
  log?: SalvageLogger,
): { rows?: AiExtractedRow[] } {
  try {
    return JSON.parse(raw) as { rows?: AiExtractedRow[] };
  } catch {
    // Locate the `rows` array, walk it row-by-row with a brace counter,
    // and stop at the last fully-balanced row object. Then reconstruct
    // `{"rows":[<balanced rows>]}` and parse that.
    const rowsStart = raw.indexOf("[");
    if (rowsStart === -1) {
      throw new Error(
        `AI extraction: model did not return valid JSON and could not be salvaged (no rows array).`,
      );
    }
    let i = rowsStart + 1;
    let lastGood = -1; // index just after the last balanced row obj
    let depth = 0;
    let inStr = false;
    let esc = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) lastGood = i + 1;
      }
      i++;
    }
    if (lastGood === -1) {
      throw new Error(
        `AI extraction: model response was truncated before any complete row could be recovered.`,
      );
    }
    const salvaged = `${raw.slice(0, lastGood)}]}`;
    try {
      const parsed = JSON.parse(salvaged) as { rows?: AiExtractedRow[] };
      (log ?? logger).warn(
        {
          customer,
          fileName,
          rawLen: raw.length,
          salvagedLen: salvaged.length,
          rows: parsed.rows?.length ?? 0,
        },
        "AI extraction: salvaged truncated JSON response",
      );
      return parsed;
    } catch (err2) {
      throw new Error(
        `AI extraction: model response was truncated and salvage failed (${(err2 as Error).message}).`,
      );
    }
  }
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const doc = await mod.getDocument({
    data,
  } as Parameters<typeof mod.getDocument>[0]).promise;
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const lines = new Map<number, Array<{ x: number; t: string }>>();
      for (const item of content.items) {
        if (typeof (item as { str?: unknown }).str !== "string") continue;
        const it = item as { str: string; transform: number[] };
        const y = Math.round(it.transform[5]);
        const arr = lines.get(y) ?? [];
        arr.push({ x: it.transform[4], t: it.str });
        lines.set(y, arr);
      }
      pages.push(
        [...lines.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, items]) =>
            items
              .sort((a, b) => a.x - b.x)
              .map((i) => i.t)
              .join(" "),
          )
          .join("\n"),
      );
    }
  } finally {
    await doc.destroy();
  }
  return pages.join("\n\n").slice(0, 200_000);
}

export async function aiExtractRows(
  fileName: string,
  buffer: Buffer,
  customer: string,
  weekStart: string,
  weekEnd: string,
  mimeType?: string,
  log?: SalvageLogger,
): Promise<AiExtractedRow[]> {
  const ai = getGeminiClient();
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isImage =
    (mimeType && /^image\//i.test(mimeType)) ||
    /\.(jpg|jpeg|png|webp)$/i.test(lower);
  const start = Date.now();

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [{ text: buildPrompt(customer, weekStart, weekEnd) }];

  if (isImage) {
    // Caller is expected to have transcoded any HEIC bytes to JPEG already
    // (see `normalizeImageBuffer`), and to pass an image/* mime here.
    const effectiveMime =
      mimeType && /^image\//i.test(mimeType) ? mimeType : "image/jpeg";
    parts.push({
      inlineData: {
        mimeType: effectiveMime,
        data: buffer.toString("base64"),
      },
    });
  } else if (isPdf) {
    const text = await extractTextFromPdf(buffer);
    if (text.trim().length > 50) {
      parts.push({
        text: `\n\n--- PDF TEXT ---\n${text}\n--- END PDF TEXT ---`,
      });
    } else {
      // Scanned PDF: send the document directly for OCR.
      parts.push({
        inlineData: {
          mimeType: "application/pdf",
          data: buffer.toString("base64"),
        },
      });
    }
  } else {
    parts.push({
      text: `\n\n--- SPREADSHEET (CSV) ---\n${xlsxToText(buffer)}\n--- END SPREADSHEET ---`,
    });
  }

  // Hard 90s ceiling on the Gemini call. Without this an unresponsive
  // upstream leaves the dispatcher staring at a frozen "Uploading…"
  // spinner for minutes with no feedback. The race doesn't actually
  // abort the HTTP request (the @google/genai SDK doesn't expose an
  // AbortSignal here) but it does free the request handler so the
  // dispatcher gets an actionable error and can Cancel + retry.
  const AI_TIMEOUT_MS = 90_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `AI extraction timed out after ${Math.round(AI_TIMEOUT_MS / 1000)}s — try uploading the original spreadsheet, a smaller/cropped image, or retry in a moment.`,
        ),
      );
    }, AI_TIMEOUT_MS);
  });
  const generate = ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema: ROW_SCHEMA,
      // Weekly customer exports for a 21-driver fleet can easily exceed
      // 8k output tokens (one row per driver per day with five string
      // fields each). Cap generously — the proxy still bills by output
      // tokens used, not requested, so headroom is free.
      maxOutputTokens: 32768,
    },
  });
  let response;
  try {
    response = await Promise.race([generate, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const raw = response.text ?? "";
  const parsed = parseOrSalvage(raw, customer, fileName, log);

  const rows = (parsed.rows ?? [])
    .filter(
      (r) => r && typeof r.driverNameOnDoc === "string" && typeof r.date === "string",
    )
    .map((r) => ({
      ...r,
      // Normalize at the ingest boundary so the dispatcher UI, the saved
      // alias, and any downstream comparisons all see the same Title Case
      // form regardless of how the source document cased the name.
      driverNameOnDoc: toDisplayName(r.driverNameOnDoc),
    }));
  logger.info(
    { ms: Date.now() - start, rows: rows.length, customer, fileName },
    "AI extraction complete",
  );
  return rows;
}
