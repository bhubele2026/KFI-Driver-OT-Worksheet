import { fmtDT } from "../time.js";
import { topMatches } from "./fuzzy.js";
import type {
  ExtractDiagnostics,
  ParseResult,
  ParsedPunch,
  PendingNamedRowOut,
} from "./types.js";
import { UnmappedIdAccumulator } from "./types.js";
import {
  aiExtractRows,
  normalizeIsoDate,
  type AiExtractOptions,
  type AiExtractedRow,
  type RosterContext,
} from "./aiExtract.js";
import type { IngestionBudgetSummary } from "./ingestionBudget.js";

/**
 * Build the RosterContext the AI prompt uses to attempt resolvedKfiId
 * on each row (Task #271). Inverts the badge map so each driver's known
 * badge/employee ids ride along, and folds in saved per-customer name
 * aliases so a previously-vetted "Joey C." → kfi pair resolves on the
 * model's first read instead of after a dispatcher round-trip.
 *
 * Caller restricts `drivers` to a sensible pool (active roster,
 * customer-preferred / this-week clock-ins for /extract-new-customer).
 */
export function buildRosterContext(args: {
  customer: string;
  drivers: Array<{ kfiId: string; name: string }>;
  idMap: Record<string, string>;
  nameAliasMap?: Map<string, string>;
}): RosterContext {
  const { customer, drivers, idMap, nameAliasMap } = args;
  const badgesByKfi = new Map<string, string[]>();
  for (const [externalId, kfiId] of Object.entries(idMap)) {
    const arr = badgesByKfi.get(kfiId) ?? [];
    arr.push(externalId);
    badgesByKfi.set(kfiId, arr);
  }
  const aliasesByKfi = new Map<string, string[]>();
  if (nameAliasMap) {
    for (const [nameOnDoc, kfiId] of nameAliasMap.entries()) {
      const arr = aliasesByKfi.get(kfiId) ?? [];
      arr.push(nameOnDoc);
      aliasesByKfi.set(kfiId, arr);
    }
  }
  return {
    customer,
    drivers: drivers.map((d) => ({
      kfiId: d.kfiId,
      name: d.name,
      // Cap each list so a driver with hundreds of historical badges
      // doesn't dominate the prompt for one customer.
      badges: (badgesByKfi.get(d.kfiId) ?? []).slice(0, 8),
      aliases: (aliasesByKfi.get(d.kfiId) ?? []).slice(0, 8),
    })),
  };
}

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
  /**
   * Optional per-customer "name on doc → kfiId" map. Consulted BEFORE the
   * fuzzy name match so previously-vetted dispatcher decisions resolve
   * automatically on subsequent uploads (i.e. once "Cole Hayek → K123" is
   * saved as a customer_name_alias for Schuette Metals, next week's photo
   * resolves him without re-prompting the picker). Keys are lower-cased
   * to forgive minor casing drift in the source doc.
   */
  nameAliasMap?: Map<string, string>;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  /**
   * Per-upload AI options bag (Task #297). Routes that care about the
   * spend ceiling / per-customer Gemini fallback opt-in build this from
   * the customers row and pass it through; tests usually omit it and
   * let `aiExtractRows` construct a throwaway budget.
   */
  aiOpts?: AiExtractOptions;
}): Promise<ParseResult & { aiBudgetSummary?: IngestionBudgetSummary }> {
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
    nameAliasMap,
    log,
    aiOpts,
  } = args;
  // Prefer drivers attached to this customer when building the roster
  // hints sent to the AI — narrows the prompt to plausible candidates
  // (and matches the fuzzy-match pool used below).
  const customerLower = customer.toLowerCase();
  const preferredDrivers = drivers.filter(
    (d) => (d.customer ?? "").toLowerCase() === customerLower,
  );
  const rosterPool = preferredDrivers.length > 0 ? preferredDrivers : drivers;
  const roster = buildRosterContext({
    customer,
    drivers: rosterPool,
    idMap,
    nameAliasMap,
  });
  const {
    rows: rawRows,
    truncated: extractionTruncated,
    failedChunks,
    budgetSummary: aiBudgetSummary,
  } = await aiExtractRows(
    fileName,
    buffer,
    customer,
    weekStart,
    weekEnd,
    mimeType,
    log,
    roster,
    aiOpts,
  );

  // Normalize Gemini's date shape before the string-compare window filter.
  // Without this, any row whose `date` came back as `5/12/2026` or
  // `May 12, 2026` (both of which the model emits despite the prompt) gets
  // silently dropped — taking the entire upload's accepted count to zero
  // and producing the dispatcher-confusing "0 punches even with AI fallback"
  // error.
  let invalidDateCount = 0;
  let outOfWindowCount = 0;
  const inWindow: AiExtractedRow[] = [];
  for (const r of rawRows) {
    const iso = normalizeIsoDate(r.date);
    if (!iso) {
      invalidDateCount++;
      continue;
    }
    if (iso < weekStart || iso > weekEnd) {
      outOfWindowCount++;
      continue;
    }
    inWindow.push({ ...r, date: iso });
  }

  // Fuzzy match falls back to the same customer-preferred pool used for
  // the AI roster hint.
  const fuzzyPool = rosterPool;

  const unmapped = new UnmappedIdAccumulator();
  const punches: ParsedPunch[] = [];
  const pendingNamedRows: PendingNamedRowOut[] = [];
  let unmappedDriverCount = 0;
  let invalidTimeCount = 0;

  for (const r of inWindow) {
    const kfiId = resolveKfiId(r, idMap, fuzzyPool, kfiSet, nameAliasMap);
    if (!kfiId) {
      const id = (r.badgeOrId ?? "").trim() || `name:${r.driverNameOnDoc}`;
      unmapped.add(id, r.driverNameOnDoc);
      unmappedDriverCount++;
      // Stash the raw row so /confirm-customer-file can re-resolve it
      // after the dispatcher picks a driver in the preview dialog.
      pendingNamedRows.push({
        driverNameOnDoc: r.driverNameOnDoc,
        badgeOrId: (r.badgeOrId ?? "").trim() || null,
        date: r.date,
        timeIn: r.timeIn ?? null,
        timeOut: r.timeOut ?? null,
        hours: typeof r.hours === "number" ? r.hours : null,
      });
      continue;
    }
    const punch = toParsedPunch(r, kfiId, customer);
    if (!punch) {
      invalidTimeCount++;
      continue;
    }
    punches.push(punch);
  }

  const diagnostics: ExtractDiagnostics = {
    rawRowCount: rawRows.length,
    invalidDateCount,
    outOfWindowCount,
    unmappedDriverCount,
    invalidTimeCount,
    acceptedCount: punches.length,
    extractionTruncated,
    failedChunks,
  };
  if (punches.length === 0 && rawRows.length > 0) {
    log?.warn(
      { customer, fileName, ...diagnostics },
      "AI extract accepted zero punches",
    );
  }
  return {
    customer,
    punches,
    unmappedIds: unmapped.toArray(),
    diagnostics,
    pendingNamedRows,
    aiBudgetSummary,
  };
}

function resolveKfiId(
  row: AiExtractedRow,
  idMap: Record<string, string>,
  fuzzyPool: Array<{ kfiId: string; name: string }>,
  kfiSet: Set<string>,
  nameAliasMap?: Map<string, string>,
): string | null {
  const badge = (row.badgeOrId ?? "").trim();
  // Badge mapping is the source of truth — when a badge maps to a
  // known kfi, that wins even over the AI's resolvedKfiId hint. This
  // is the badge-disagree guard (Task #271): if the model's pick
  // contradicts the historical badge → kfi mapping for this same
  // badge, we trust the badge and ignore the AI hint.
  //
  // The lookup is case-insensitive to match `driver_id_aliases`'
  // lower(external_id) unique index — otherwise `TELD123` in the
  // DB and `teld123` from the doc would slip past the guard and
  // let the AI hint resolve a row that should have been pinned by
  // the existing mapping.
  if (badge) {
    const mapped = idMap[badge] ?? idMap[badge.toLowerCase()] ?? idMap[badge.toUpperCase()];
    if (mapped && kfiSet.has(mapped)) return mapped;
    if (kfiSet.has(badge)) return badge;
  }
  // AI hint (Task #271). Only accepted when the model returned an id
  // that's actually in the active roster. We also require the
  // resolvedKfiId target to be in the pool we sent to the prompt — if
  // it picked someone from an unrelated customer or someone we never
  // listed, treat it as a hallucination and fall through.
  const aiPick = (row.resolvedKfiId ?? "").trim();
  if (aiPick && kfiSet.has(aiPick)) {
    if (fuzzyPool.some((d) => d.kfiId === aiPick)) return aiPick;
  }
  const name = row.driverNameOnDoc.trim();
  if (!name) return null;
  // Saved per-customer name alias wins over fuzzy match — the dispatcher
  // already vouched for this pairing on a prior upload, so resolve
  // deterministically.
  if (nameAliasMap) {
    const aliased = nameAliasMap.get(name.toLowerCase());
    if (aliased && kfiSet.has(aliased)) return aliased;
  }
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
    // Always normalize through fmtDT so AI-extracted rows land in DB as
    // canonical `YYYY-MM-DD h:MM AM/PM` regardless of what shape Gemini
    // returned (24-hour, seconds, mixed case). Task #247.
    clockIn: fmtDT(`${r.date} ${clockIn}`),
    clockOut: fmtDT(`${r.date} ${clockOut}`),
    hours: Math.round(hours * 1000) / 1000,
    payType: "Reg",
    // Carry the raw badge through so the PDF schema-cache recorder can
    // locate the originating line in the document. Not persisted.
    rawBadge: (r.badgeOrId ?? "").trim() || null,
  };
}
