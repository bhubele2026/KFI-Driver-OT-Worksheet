import { topMatches } from "./fuzzy.js";
import type { ParseResult, ParsedPunch } from "./types.js";
import { UnmappedIdAccumulator } from "./types.js";
import { aiExtractRows, type AiExtractedRow } from "./aiExtract.js";

export const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "heic",
  "heif",
  "webp",
] as const;

export type ImageExt = (typeof IMAGE_EXTENSIONS)[number];

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function imageExtension(fileName: string): ImageExt | null {
  const lower = fileName.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(`.${ext}`)) return ext;
  }
  return null;
}

export function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime);
}

/**
 * Convert a HEIC/HEIF buffer to JPEG bytes. We do this server-side because
 * Gemini does not accept HEIC inlineData, and browsers can't read HEIC
 * either (the user's iPhone photo would otherwise be unreviewable).
 */
export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  // heic-convert is CommonJS; the default export accepts `{ buffer, format,
  // quality }` and returns a Uint8Array. Wrap so callers always get a Buffer.
  // @ts-expect-error heic-convert ships no type declarations.
  const mod = await import("heic-convert");
  const convert = (mod as { default: unknown }).default as (args: {
    buffer: ArrayBufferLike | Uint8Array;
    format: "JPEG" | "PNG";
    quality?: number;
  }) => Promise<ArrayBuffer | Uint8Array>;
  const out = await convert({ buffer, format: "JPEG", quality: 0.9 });
  return Buffer.from(out as Uint8Array);
}

/**
 * If the upload is HEIC/HEIF, transcode to JPEG. Returns the buffer + the
 * effective mime type to pass downstream (e.g. to Gemini inlineData).
 */
export async function normalizeImageBuffer(
  fileName: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const ext = imageExtension(fileName);
  const isHeic =
    ext === "heic" ||
    ext === "heif" ||
    /^image\/heic|heif/i.test(mimeType);
  if (!isHeic) {
    // Default to a well-formed mime so Gemini accepts it.
    if (!isImageMime(mimeType)) {
      const fallback =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";
      return { buffer, mimeType: fallback };
    }
    return { buffer, mimeType };
  }
  const jpeg = await convertHeicToJpeg(buffer);
  return { buffer: jpeg, mimeType: "image/jpeg" };
}

/**
 * Run AI extraction on an image and map the resulting rows back to known KFI
 * drivers using the badge/id map (with a fuzzy name-match fallback against
 * the supplied driver roster, scoped to the customer when possible). Returns
 * a ParseResult identical in shape to a deterministic parser's output so the
 * known-customer extract/confirm flow can persist it without special-casing.
 */
export async function extractImageForKnownCustomer(args: {
  fileName: string;
  buffer: Buffer;
  mimeType: string;
  customer: string;
  weekStart: string;
  weekEnd: string;
  idMap: Record<string, string>;
  drivers: Array<{ kfiId: string; name: string; customer: string | null }>;
  kfiSet: Set<string>;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<ParseResult> {
  const {
    fileName,
    buffer,
    mimeType,
    customer,
    weekStart,
    weekEnd,
    idMap,
    drivers,
    kfiSet,
    log,
  } = args;
  const rawRows = await aiExtractRows(
    fileName,
    buffer,
    customer,
    weekStart,
    weekEnd,
    mimeType,
    log,
  );
  const inWindow = rawRows.filter(
    (r) => r.date >= weekStart && r.date <= weekEnd,
  );

  // Prefer drivers attached to this customer when fuzzy-matching by name.
  const customerLower = customer.toLowerCase();
  const preferredDrivers = drivers.filter(
    (d) => (d.customer ?? "").toLowerCase() === customerLower,
  );
  const fuzzyPool = preferredDrivers.length > 0 ? preferredDrivers : drivers;

  const unmapped = new UnmappedIdAccumulator();
  const punches: ParsedPunch[] = [];

  for (const r of inWindow) {
    const kfiId = resolveKfiId(r, idMap, fuzzyPool, kfiSet);
    if (!kfiId) {
      const id = (r.badgeOrId ?? "").trim() || `name:${r.driverNameOnDoc}`;
      unmapped.add(id, r.driverNameOnDoc);
      continue;
    }
    const punch = toParsedPunch(r, kfiId, customer);
    if (punch) punches.push(punch);
  }

  return { customer, punches, unmappedIds: unmapped.toArray() };
}

function resolveKfiId(
  row: AiExtractedRow,
  idMap: Record<string, string>,
  fuzzyPool: Array<{ kfiId: string; name: string }>,
  kfiSet: Set<string>,
): string | null {
  const badge = (row.badgeOrId ?? "").trim();
  if (badge) {
    const mapped = idMap[badge];
    if (mapped && kfiSet.has(mapped)) return mapped;
    if (kfiSet.has(badge)) return badge;
  }
  const name = row.driverNameOnDoc.trim();
  if (!name) return null;
  const matches = topMatches(
    name,
    fuzzyPool.map((d) => ({ kfiId: d.kfiId, name: d.name, customer: "" })),
    1,
  );
  const best = matches[0];
  // Only accept a fuzzy match when the model is very confident. Anything
  // weaker bubbles up to the dispatcher as an unmapped row rather than
  // silently attributing punches to the wrong driver.
  if (best && best.confidence >= 0.85 && kfiSet.has(best.kfiId)) {
    return best.kfiId;
  }
  return null;
}

function toParsedPunch(
  r: AiExtractedRow,
  kfiId: string,
  customer: string,
): ParsedPunch | null {
  const clockIn = (r.timeIn ?? "").trim();
  const clockOut = (r.timeOut ?? "").trim();
  let hours = typeof r.hours === "number" && r.hours > 0 ? r.hours : 0;
  if (!hours && clockIn && clockOut) {
    const ms =
      new Date(`${r.date} ${clockOut}`).getTime() -
      new Date(`${r.date} ${clockIn}`).getTime();
    if (!Number.isNaN(ms) && ms > 0) {
      hours = Math.round((ms / 3_600_000) * 1000) / 1000;
    }
  }
  if (!(hours > 0)) return null;
  if (!clockIn || !clockOut) return null;
  return {
    kfiId,
    customer,
    date: r.date,
    clockIn: `${r.date} ${clockIn}`,
    clockOut: `${r.date} ${clockOut}`,
    hours: Math.round(hours * 1000) / 1000,
    payType: "Reg",
  };
}
