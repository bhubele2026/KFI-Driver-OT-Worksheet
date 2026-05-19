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
export function parseOrSalvage(
  raw: string,
  customer: string,
  fileName: string,
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
      logger.warn(
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

  const response = await ai.models.generateContent({
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

  const raw = response.text ?? "";
  const parsed = parseOrSalvage(raw, customer, fileName);

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
