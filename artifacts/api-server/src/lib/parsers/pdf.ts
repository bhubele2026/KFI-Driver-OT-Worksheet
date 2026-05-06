import { EMBEDDED_MAPPING } from "../mappings.js";
import { ocrDelalloPDF } from "./ocr.js";
import type { ParsedPunch } from "./types.js";

// pdfjs-dist is huge and tries to dynamically load workers; we always use the
// legacy build in Node and disable workers explicitly.
async function loadPdfjs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function pageLines(
  page: import("pdfjs-dist/legacy/build/pdf.mjs").PDFPageProxy,
): Promise<string[]> {
  const content = await page.getTextContent();
  const rows = new Map<number, Array<{ x: number; text: string }>>();
  for (const item of content.items) {
    if (typeof (item as { str?: unknown }).str !== "string") continue;
    const it = item as { str: string; transform: number[] };
    const y = Math.round(it.transform[5]);
    const arr = rows.get(y) ?? [];
    arr.push({ x: it.transform[4], text: it.str.trim() });
    rows.set(y, arr);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, items]) =>
      items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text)
        .filter((t) => t.length > 0)
        .join(" "),
    );
}

async function withPdf<T>(
  buffer: Buffer,
  handler: (pages: () => AsyncGenerator<string[]>) => Promise<T>,
): Promise<T> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data } as Parameters<typeof pdfjs.getDocument>[0])
    .promise;
  async function* gen() {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      yield pageLines(page);
    }
  }
  try {
    return await handler(gen);
  } finally {
    await doc.destroy();
  }
}

export async function parseAdientPDF(
  buffer: Buffer,
  kfiSet: Set<string>,
  year: number,
): Promise<ParsedPunch[]> {
  const punches: ParsedPunch[] = [];
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  let kfiId: string | null = null;
  let totalLines = 0;
  await withPdf(buffer, async (pages) => {
    for await (const lines of pages()) {
      totalLines += lines.length;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const empMatch = line.match(/\((TELD\d+)\)/);
        if (empMatch) {
          kfiId = EMBEDDED_MAPPING[empMatch[1]] ?? null;
          continue;
        }
        if (!kfiId || !kfiSet.has(kfiId)) continue;
        const dateMatch = line.match(
          /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+),\s+(\d{4})/,
        );
        if (!dateMatch) continue;
        const date = `${dateMatch[3]}-${months[dateMatch[1]]}-${String(parseInt(dateMatch[2])).padStart(2, "0")}`;
        if (!date.startsWith(String(year))) continue;
        let hours = 0;
        let clockIn = date;
        let clockOut = date;
        for (let j = i; j < Math.min(i + 4, lines.length); j++) {
          const m = lines[j].match(/\b((?:[1-9]|1[0-9]|2[0-4])\.\d{2})\b/);
          if (m) {
            const h = parseFloat(m[1]);
            if (h > 0 && h < 25) {
              hours = h;
              break;
            }
          }
        }
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const times = lines[j].match(/\b(\d{1,2}:\d{2}\s*[AP]M)\b/gi);
          if (times && times.length >= 2) {
            clockIn = `${date} ${times[0]}`;
            clockOut = `${date} ${times[1]}`;
            break;
          }
        }
        if (hours > 0) {
          punches.push({
            kfiId,
            customer: "Adient",
            date,
            clockIn,
            clockOut,
            hours,
            payType: "Reg",
          });
        }
      }
    }
    return undefined;
  });
  assertExtractable("Adient", totalLines);
  return punches;
}

function assertExtractable(label: string, totalLines: number) {
  if (totalLines === 0) {
    throw new Error(
      `${label} parser: no extractable text in PDF (likely a scanned image). Ask ${label} for a digital export, or OCR the file before uploading.`,
    );
  }
}

export async function parseIWGPDF(
  buffer: Buffer,
  kfiSet: Set<string>,
): Promise<ParsedPunch[]> {
  const punches: ParsedPunch[] = [];
  let kfiId: string | null = null;
  let totalLines = 0;
  await withPdf(buffer, async (pages) => {
    for await (const lines of pages()) {
      totalLines += lines.length;
      for (const line of lines) {
        const empMatch = line.match(/Employee:\s+.+?\s+ID:\s+(\d+)/);
        if (empMatch) {
          kfiId = EMBEDDED_MAPPING[empMatch[1]] ?? null;
          continue;
        }
        if (!kfiId || !kfiSet.has(kfiId)) continue;
        const m = line.match(
          /(\d{4}-\d{2}-\d{2})\s+(\d+:\d+\s*[AP]M).*?(\d+:\d+\s*[AP]M)\s+([\d.]+)/,
        );
        if (!m) continue;
        const hours = parseFloat(m[4]);
        if (!(hours > 0 && hours < 25)) continue;
        punches.push({
          kfiId,
          customer: "International Wire Group",
          date: m[1],
          clockIn: `${m[1]} ${m[2]}`,
          clockOut: `${m[1]} ${m[3]}`,
          hours,
          payType: "Reg",
          noTz: true,
        });
      }
    }
    return undefined;
  });
  assertExtractable("IWG", totalLines);
  return punches;
}

export async function parseDelalloPDF(
  buffer: Buffer,
  kfiSet: Set<string>,
  year: number,
): Promise<ParsedPunch[]> {
  const punches: ParsedPunch[] = [];
  let kfiId: string | null = null;
  let totalLines = 0;
  await withPdf(buffer, async (pages) => {
    for await (const lines of pages()) {
      totalLines += lines.length;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const badge = line.match(/Badge\s*[#:]+\s*(\d+)/i);
        if (badge) {
          kfiId = EMBEDDED_MAPPING[badge[1]] ?? null;
          continue;
        }
        if (!kfiId || !kfiSet.has(kfiId)) continue;
        const dm = line.match(
          /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^)]*\(?(\d{2}\/\d{2})\)?/i,
        );
        if (!dm) continue;
        const [mo, dy] = dm[1].split("/");
        const date = `${year}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}`;
        let hours = 0;
        for (let j = i; j < Math.min(i + 4, lines.length); j++) {
          const all = lines[j].match(/\b(\d+\.\d{2})\b/g);
          if (!all) continue;
          for (const h of all) {
            const v = parseFloat(h);
            if (v > 0 && v < 25 && v !== 2.0) {
              hours = v;
              break;
            }
          }
          if (hours > 0) break;
        }
        const tm = line.match(
          /(\d+:\d+(?::\d+)?\s*[AP]M).*?(\d+:\d+(?::\d+)?\s*[AP]M)/i,
        );
        let clockIn = date;
        let clockOut = date;
        if (tm) {
          clockIn = `${date} ${tm[1]}`;
          clockOut = `${date} ${tm[2]}`;
        }
        if (hours > 0) {
          punches.push({
            kfiId,
            customer: "DeLallo",
            date,
            clockIn,
            clockOut,
            hours,
            payType: "Reg",
          });
        }
      }
    }
    return undefined;
  });
  if (totalLines === 0) {
    // Scanned image PDF (no text layer). Fall back to OCR via Gemini vision.
    return ocrDelalloPDF(buffer, kfiSet, year);
  }
  return punches;
}
