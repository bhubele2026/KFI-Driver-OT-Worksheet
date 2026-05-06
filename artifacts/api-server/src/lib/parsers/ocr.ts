import { Type } from "@google/genai";
import { EMBEDDED_MAPPING } from "../mappings.js";
import { logger } from "../logger.js";
import { getGeminiClient } from "./gemini.js";
import type { ParsedPunch } from "./types.js";

interface OcrPunchRow {
  badge: string;
  date: string; // MM/DD or YYYY-MM-DD
  clockIn?: string; // "H:MM AM/PM"
  clockOut?: string; // "H:MM AM/PM"
  hours: number;
}

const PUNCH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    punches: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          badge: { type: Type.STRING },
          date: { type: Type.STRING },
          clockIn: { type: Type.STRING },
          clockOut: { type: Type.STRING },
          hours: { type: Type.NUMBER },
        },
        required: ["badge", "date", "hours"],
      },
    },
  },
  required: ["punches"],
};

function normalizeDate(raw: string, year: number): string | null {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;
  const md = raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (md) {
    const mo = md[1].padStart(2, "0");
    const dy = md[2].padStart(2, "0");
    let y = year;
    if (md[3]) {
      const yy = parseInt(md[3]);
      y = yy < 100 ? 2000 + yy : yy;
    }
    return `${y}-${mo}-${dy}`;
  }
  return null;
}

function normalizeTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)$/i);
  if (!m) return null;
  return `${parseInt(m[1])}:${m[2]} ${m[3].toUpperCase()}`;
}

export async function ocrDelalloPDF(
  buffer: Buffer,
  kfiSet: Set<string>,
  year: number,
  unmappedIds: Set<string>,
): Promise<ParsedPunch[]> {
  const ai = getGeminiClient();
  const start = Date.now();

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: buffer.toString("base64"),
            },
          },
          {
            text: [
              "This is a scanned DeLallo daily-punches payroll PDF.",
              "Extract every punch row for every employee shown on every page.",
              'For each row return: badge (the employee Badge # as a string of digits), date (use "MM/DD" if no year is shown), clockIn ("H:MM AM/PM" or "H:MM:SS AM/PM"), clockOut (same format), and hours (the daily hours number, e.g. 8.50).',
              "If a row has no clock-in/clock-out times leave them empty but still include the row if hours > 0.",
              "Do not invent rows. Skip lines that are not punch rows (totals, headers, footers, signatures).",
              "Return strictly the JSON object matching the provided schema.",
            ].join(" "),
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: PUNCH_SCHEMA,
      maxOutputTokens: 32768,
    },
  });

  const raw = response.text ?? "";
  let parsed: { punches?: OcrPunchRow[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `DeLallo OCR fallback: model did not return valid JSON (${(err as Error).message}).`,
    );
  }

  const out: ParsedPunch[] = [];
  for (const row of parsed.punches ?? []) {
    const badge = String(row.badge ?? "").trim();
    const kfiId = EMBEDDED_MAPPING[badge];
    if (!kfiId || !kfiSet.has(kfiId)) {
      if (/^\d+$/.test(badge)) unmappedIds.add(badge);
      continue;
    }
    const date = normalizeDate(String(row.date).trim(), year);
    if (!date) continue;
    const hours = Number(row.hours);
    // Match the digital parser: skip the 2.00 sentinel value that appears in
    // DeLallo summary rows (it's a column header / total, not a real punch).
    if (!(hours > 0 && hours < 25) || hours === 2.0) continue;
    const ci = normalizeTime(row.clockIn);
    const co = normalizeTime(row.clockOut);
    out.push({
      kfiId,
      customer: "DeLallo",
      date,
      clockIn: ci ? `${date} ${ci}` : date,
      clockOut: co ? `${date} ${co}` : date,
      hours,
      payType: "Reg",
    });
  }

  logger.info(
    { ms: Date.now() - start, rows: out.length, raw: parsed.punches?.length ?? 0 },
    "DeLallo OCR fallback complete",
  );
  return out;
}
