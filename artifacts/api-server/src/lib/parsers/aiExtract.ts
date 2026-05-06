import * as XLSX from "xlsx";
import { Type } from "@google/genai";
import { logger } from "../logger.js";
import { getGeminiClient } from "./gemini.js";

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
    `The week being reconciled is ${weekStart} through ${weekEnd} (Monday through Sunday). Only return rows whose date falls in that window.`,
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
): Promise<AiExtractedRow[]> {
  const ai = getGeminiClient();
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const start = Date.now();

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [{ text: buildPrompt(customer, weekStart, weekEnd) }];

  if (isPdf) {
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
      maxOutputTokens: 8192,
    },
  });

  const raw = response.text ?? "";
  let parsed: { rows?: AiExtractedRow[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AI extraction: model did not return valid JSON (${(err as Error).message}).`,
    );
  }

  const rows = (parsed.rows ?? []).filter(
    (r) => r && typeof r.driverNameOnDoc === "string" && typeof r.date === "string",
  );
  logger.info(
    { ms: Date.now() - start, rows: rows.length, customer, fileName },
    "AI extraction complete",
  );
  return rows;
}
