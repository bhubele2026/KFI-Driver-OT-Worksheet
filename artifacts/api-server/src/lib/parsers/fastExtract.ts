import * as XLSX from "xlsx";
import type { ContentPart } from "./modelClient.js";
import { ClaudeModelClient } from "./claude.js";
import { normalizeImageBuffer } from "./imageSupport.js";
import {
  parseOrSalvage,
  type AiExtractedRow,
  type RosterContext,
} from "./aiExtract.js";
import { nameSimilarity, nameMatchQuality } from "./fuzzy.js";
import { repairZipSizes } from "./zipRepair.js";
import type { SalvageLogger } from "./jsonSalvage.js";
import type { IngestionBudgetSummary } from "./ingestionBudget.js";

/**
 * Clean-slate customer-timesheet extraction: TWO small model calls per
 * file, no chunking, no schema cache, no pacer. Drop-in replacement for
 * the old `aiExtractRows` (same signature + return), so all the
 * downstream matching / review / confirm logic in
 * `extractImageForKnownCustomer` is reused unchanged.
 *
 * Architecture — the AI reads, the SERVER matches (2026-07-23):
 *
 *  1. CENSUS call: "list every worker name + badge on the sheet" —
 *     tiny output, no matching asked of the model at all.
 *  2. Server matching: census names/badges vs the FULL fleet roster
 *     (badge/alias equality, then fuzzy name) — deterministic code, and
 *     never narrowed to a customer tag (narrowing turned "driver tagged
 *     to the wrong customer" into a silent 0-punch dead end — the IWG
 *     El Paso failure). Borderline names are kept and surface in the
 *     preview's picker instead of being dropped.
 *  3. EXTRACT call: "extract punch rows for EXACTLY these workers" —
 *     the filter-shaped prompt the model obeys reliably and fast.
 *
 * Why not one call: asking the model to classify 500 sheet workers
 * against a 58-driver list while streaming punches made it either
 * extract everyone (343 rows, token-cap truncation) or narrate/think
 * itself past the 180s timeout — across three prompt iterations. List
 * matching is the server's job; each remaining model task is mechanical
 * and provably quick.
 */

/** File bytes → the content block(s) we hand the model, no chunking. */
async function prepareContentParts(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ContentPart[]> {
  const lower = fileName.toLowerCase();
  const mt = (mimeType || "").toLowerCase();
  const isPdf = mt === "application/pdf" || lower.endsWith(".pdf");
  const isImage =
    mt.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|heic|heif)$/.test(lower);
  const isSheet =
    /spreadsheet|excel|ms-excel/.test(mt) || /\.(xlsx?|xlsm|csv)$/.test(lower);

  if (isSheet) {
    // Dump every sheet to CSV in one text block, labeled by tab name so the
    // model can pick the right sheet (e.g. Orgill's timecard vs Zenople master).
    let wb: XLSX.WorkBook | undefined;
    try {
      wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Some customer exporters write zips whose central-directory sizes
      // disagree with the local headers ("Bad compressed size: 0 != 443").
      // Excel opens them fine; xlsx.js throws. Repair the headers and try
      // once more before declaring the file corrupt.
      if (/bad (un)?compressed size|bad crc/i.test(detail)) {
        const repaired = repairZipSizes(buffer);
        if (repaired.changed) {
          try {
            wb = XLSX.read(repaired.buffer, { type: "buffer", cellDates: true });
          } catch {
            // fall through to the friendly error below
          }
        }
      }
      if (!wb) {
        // Genuinely corrupt/truncated (e.g. cut off in transit, cloud
        // placeholder) — say so in words a dispatcher can act on.
        throw new Error(
          `Couldn't open "${fileName}" as an Excel file — it looks corrupted or only partially uploaded (${detail}). Upload it again; if it keeps failing, open it in Excel, re-save it, and try once more.`,
        );
      }
    }
    const blocks: string[] = [];
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
      blocks.push(`===== SHEET: ${name} =====\n${csv}`);
    }
    // cacheable: the census call warms Anthropic's prompt cache with the
    // sheet body; the extract call seconds later reads it back at ~10% of
    // the input price and much faster time-to-first-token.
    return [{ kind: "text", text: blocks.join("\n\n"), cacheable: true }];
  }
  if (isPdf) {
    return [
      { kind: "inlineData", mimeType: "application/pdf", data: buffer.toString("base64") },
    ];
  }
  if (isImage) {
    const norm = await normalizeImageBuffer(fileName, mimeType, buffer);
    return [
      { kind: "inlineData", mimeType: norm.mimeType, data: norm.buffer.toString("base64") },
    ];
  }
  // Unknown type — best effort: hand the raw text.
  return [{ kind: "text", text: buffer.toString("utf8").slice(0, 200_000), cacheable: true }];
}

/** Strip any prose the model narrates before the JSON object. */
function stripToJson(text: string): string {
  const braceAt = text.indexOf("{");
  return braceAt > 0 ? text.slice(braceAt) : text;
}

interface CensusWorker {
  name: string;
  badge: string | null;
}

/** Pass 1 — names only. No matching, no punches: mechanical and tiny. */
function buildCensusPrompt(customer: string): string {
  return [
    `You read a customer's timesheet document for KFI Staffing. Customer: "${customer}".`,
    ``,
    `List every distinct WORKER (person) who appears on the sheet — one entry per person, even if they have many rows.`,
    `- name: exactly as written on the sheet.`,
    `- badge: the worker's id/badge/employee-number on the sheet, if shown; else null.`,
    `Skip column headers, blank rows, page footers, and total/subtotal rows. Do not invent names.`,
    ``,
    `Return ONLY raw JSON of the form {"workers":[{"name":"…","badge":"…"}]}. Start your reply with "{" — no markdown fences, no prose.`,
  ].join("\n");
}

/**
 * Pass 2 — the filter-shaped extraction prompt the model reliably obeys,
 * except the worker list now comes from server-side fleet matching
 * instead of a DB customer tag.
 */
function buildExtractPrompt(
  customer: string,
  weekStart: string,
  weekEnd: string,
  targets: Array<{ name: string; badge: string | null; kfiId: string | null }>,
): string {
  const lines = [
    `You extract timecard punches for KFI Staffing from a customer's timesheet.`,
    `Customer: "${customer}". Pay week: ${weekStart} through ${weekEnd} (Sunday–Saturday). Only include rows whose date is in that window.`,
    ``,
    `Extract punches ONLY for the workers listed below, exactly as their names appear on the sheet. Ignore every other worker completely.`,
    ``,
  ];
  for (const t of targets) {
    const badge = t.badge ? ` (badge ${t.badge})` : "";
    const kfi = t.kfiId
      ? `resolvedKfiId "${t.kfiId}"`
      : `resolvedKfiId UNKNOWN — output their rows WITHOUT resolvedKfiId`;
    lines.push(`- "${t.name}"${badge} → ${kfi}`);
  }
  lines.push(
    ``,
    `For each listed worker's daily punch, output an object with:`,
    `- resolvedKfiId: exactly the id given above for that worker; omit the field where marked UNKNOWN. Never guess.`,
    `- driverNameOnDoc: the worker's name exactly as written on the sheet.`,
    `- badgeOrId: the worker's id/badge/employee-number on the sheet, if any.`,
    `- date: YYYY-MM-DD (use the pay week to fill in the year if the sheet shows only M/D).`,
    `- hours: the day's worked hours as a decimal. USE THE SHEET'S OWN Total/Hours/Duration COLUMN when present — it already nets unpaid breaks and the customer's rounding. If a single day is split across pay-category rows (Reg + OT 1.5 + …), SUM them into one number for that day.`,
    `- timeIn / timeOut: clock in/out as "H:MM AM" / "H:MM PM" when shown; omit if only totals are given.`,
    ``,
    `Emit ONE object per listed worker per day. Skip column headers, blank rows, page footers, and any total/subtotal/grand-total rows.`,
    ``,
    `Return ONLY raw JSON of the form {"rows":[ {…}, {…} ]}. Start your reply with "{" — no markdown fences, no prose. Do not invent rows, workers, dates, or hours that aren't on the sheet.`,
  );
  return lines.join("\n");
}

/**
 * Server-side census → fleet matching. Deterministic ladder per worker:
 * badge/alias equality → confident kfiId; fuzzy name ≥0.85 → confident
 * kfiId; fuzzy ≥0.80 → borderline (extract WITHOUT an id so the preview
 * picker decides); below → stranger (names surface in `otherWorkers`).
 * The borderline floor is deliberately tight: token-set similarity gives
 * surname-only overlaps ~0.7+ (100-worker Penda census matched 71 at a
 * 0.72 floor → 341-row extract, token cap, 189s), while real spelling
 * variants of the same person score ≥0.85.
 * The roster is always the FULL active fleet — customer tags never gate.
 */
export function matchCensusToFleet(
  workers: CensusWorker[],
  roster: RosterContext | undefined,
): {
  targets: Array<{ name: string; badge: string | null; kfiId: string | null }>;
  strangers: string[];
  laneCounts: {
    badge: number;
    nameAlias: number;
    fuzzyConfident: number;
    fuzzyBorderline: number;
    zeroCtBlocked: number;
  };
  laneSamples: string[];
} {
  const drivers = roster?.drivers ?? [];
  const laneCounts = {
    badge: 0,
    nameAlias: 0,
    fuzzyConfident: 0,
    fuzzyBorderline: 0,
    zeroCtBlocked: 0,
  };
  const laneSamples: string[] = [];
  // Hard zero-CT rule: with the set provided, NO lane may attach customer
  // time to a driver who has no Connecteam time this week. Returns true
  // (and files the worker as a stranger with the reason) when blocked.
  const ctActive = roster?.ctActiveKfiIds ? new Set(roster.ctActiveKfiIds) : null;
  const zeroCtBlocked = (w: CensusWorker, kfiId: string, strangers: string[]): boolean => {
    if (!ctActive || ctActive.has(kfiId)) return false;
    laneCounts.zeroCtBlocked++;
    if (laneSamples.length < 15) {
      laneSamples.push(`${w.name}→${kfiId} BLOCKED no-CT-time`);
    }
    strangers.push(`${w.name} — matched a driver with no Connecteam time this week`);
    return true;
  };
  if (drivers.length === 0) {
    // No fleet context — extract everyone and let the picker sort it out.
    return {
      targets: workers.map((w) => ({ name: w.name, badge: w.badge, kfiId: null })),
      strangers: [],
      laneCounts,
      laneSamples,
    };
  }
  // Pinned badges (driver_id_aliases — dispatcher-vouched) are trusted
  // outright. A badge that merely EQUALS some driver's kfiId is a known
  // collision surface (customer employee-number id spaces overlap the
  // kfi range — Task #363), so a self-map hit additionally requires the
  // census name to not obviously disagree with that driver's name.
  const byPinnedBadge = new Map<string, string>();
  const bySelfKfi = new Map<string, string>();
  const nameByKfi = new Map<string, string>();
  const byNameAlias = new Map<string, string>();
  for (const d of drivers) {
    nameByKfi.set(d.kfiId, d.name);
    bySelfKfi.set(d.kfiId.toLowerCase(), d.kfiId);
    for (const b of d.badges) byPinnedBadge.set(b.trim().toLowerCase(), d.kfiId);
    // Saved picker decisions are NAME spellings, not badges — separate map.
    for (const a of d.aliases) byNameAlias.set(a.trim().toLowerCase(), d.kfiId);
  }
  const targets: Array<{ name: string; badge: string | null; kfiId: string | null }> = [];
  const strangers: string[] = [];
  for (const w of workers) {
    const badge = (w.badge ?? "").trim();
    let badgeHit = badge ? byPinnedBadge.get(badge.toLowerCase()) : undefined;
    if (!badgeHit && badge) {
      const selfHit = bySelfKfi.get(badge.toLowerCase());
      if (
        selfHit &&
        nameSimilarity(w.name, nameByKfi.get(selfHit) ?? "") >= 0.5
      ) {
        badgeHit = selfHit;
      }
    }
    const nameHit = byNameAlias.get(w.name.trim().toLowerCase());
    if (badgeHit || nameHit) {
      const resolved = badgeHit ?? nameHit ?? null;
      if (resolved && zeroCtBlocked(w, resolved, strangers)) continue;
      if (badgeHit) laneCounts.badge++;
      else laneCounts.nameAlias++;
      if (laneSamples.length < 15) {
        laneSamples.push(
          `${w.name}|${badge || "-"}→${resolved} via ${badgeHit ? "badge" : "nameAlias"}`,
        );
      }
      targets.push({ name: w.name, badge: w.badge, kfiId: resolved });
      continue;
    }
    // Score EVERY driver; a lone winner is confident, but near-ties across
    // DISTINCT drivers must never be settled by array order (that is how a
    // duplicate/same-named person stole punches — 2026-07-23). Tiebreak by
    // the uploaded customer's tag; still ambiguous → picker decides.
    // AUTO-assign additionally requires the structural gate (first AND
    // last name agree, document name covers the driver's full name) — a
    // bare "Juan" scores 1.0 by average but must never claim "Juan Disla".
    const scored = drivers
      .map((d) => ({ d, q: nameMatchQuality(w.name, d.name) }))
      .sort((a, b) => b.q.score - a.q.score);
    const bestScore = scored[0]?.q.score ?? 0;
    const bestName = scored[0]?.d.name ?? "";
    // Full coverage (every roster token matched, first AND last) is the
    // gate — NOT the averaged score, which extra document-side surname
    // tokens legitimately drag down ("Lunar Molina, Aldo" → "Aldo Lunar").
    const assignable = scored.filter(
      (x) => x.q.strongPairs >= 2 && x.q.fullCoverage,
    );
    if (assignable.length > 0) {
      const topScore = assignable[0].q.score;
      const nearTies = assignable.filter((x) => topScore - x.q.score <= 0.03);
      let pick: string | null = null;
      if (nearTies.length === 1) {
        pick = nearTies[0].d.kfiId;
      } else {
        const custLower = (roster?.customer ?? "").trim().toLowerCase();
        const tagged = nearTies.filter(
          (x) => (x.d.customer ?? "").trim().toLowerCase() === custLower,
        );
        if (tagged.length === 1) pick = tagged[0].d.kfiId;
      }
      if (pick) {
        if (zeroCtBlocked(w, pick, strangers)) continue;
        laneCounts.fuzzyConfident++;
        if (laneSamples.length < 15) {
          laneSamples.push(`${w.name}→${bestName} @${topScore.toFixed(2)}`);
        }
        targets.push({ name: w.name, badge: w.badge, kfiId: pick });
      } else {
        // Ambiguous humans — extract the punches, let the picker assign.
        laneCounts.fuzzyBorderline++;
        if (laneSamples.length < 15) {
          laneSamples.push(`${w.name}⇄AMBIGUOUS @${topScore.toFixed(2)}`);
        }
        targets.push({ name: w.name, badge: w.badge, kfiId: null });
      }
    } else if (
      bestScore >= 0.8 ||
      // Partial-surname near-miss: first name plus ONE of a multi-surname
      // driver's last names agree ("Reyes, Erica" ↔ CT "Erica Silverio").
      // The averaged score can dip below 0.8 when the document carries the
      // OTHER surname — extract the rows and let the picker decide instead
      // of silently discarding a real driver's week (WB, 2026-08-04).
      scored.some((x) => x.q.strongPairs >= 2)
    ) {
      // Close enough that a human should look — extract, no id, picker decides.
      laneCounts.fuzzyBorderline++;
      if (laneSamples.length < 15) {
        laneSamples.push(`${w.name}~${bestName} @${bestScore.toFixed(2)}`);
      }
      targets.push({ name: w.name, badge: w.badge, kfiId: null });
    } else {
      strangers.push(w.badge ? `${w.name} (${w.badge})` : w.name);
    }
  }
  return { targets, strangers, laneCounts, laneSamples };
}

/**
 * Two-call extraction. Same signature/return as the old `aiExtractRows`
 * so it drops straight into `extractImageForKnownCustomer`.
 */
export async function fastExtractRows(
  fileName: string,
  buffer: Buffer,
  customer: string,
  weekStart: string,
  weekEnd: string,
  mimeType?: string,
  log?: SalvageLogger,
  roster?: RosterContext,
): Promise<{
  rows: AiExtractedRow[];
  otherWorkers?: string[];
  budgetSummary?: IngestionBudgetSummary;
}> {
  const parts = await prepareContentParts(
    buffer,
    mimeType ?? "application/octet-stream",
    fileName,
  );
  const client = new ClaudeModelClient(); // uses CLAUDE_EXTRACT_MODEL (Sonnet 5)
  const started = Date.now();

  // ---- Pass 1: census (who is on this sheet?) ----
  const census = await client.generate({
    parts: [...parts, { kind: "text", text: buildCensusPrompt(customer) }],
    maxOutputTokens: 16384,
    timeoutMs: 120_000,
  });
  let workers: CensusWorker[] = [];
  try {
    const parsed = JSON.parse(stripToJson(census.text)) as { workers?: unknown };
    if (Array.isArray(parsed.workers)) {
      workers = parsed.workers
        .filter(
          (w): w is { name: string; badge?: unknown } =>
            !!w && typeof (w as { name?: unknown }).name === "string" &&
            (w as { name: string }).name.trim().length > 0,
        )
        .map((w) => ({
          name: w.name.trim(),
          badge:
            typeof w.badge === "string" && w.badge.trim().length > 0
              ? w.badge.trim()
              : null,
        }))
        .slice(0, 1000);
    }
  } catch (err) {
    log?.warn(
      { customer, fileName, err: String(err), censusChars: census.text.length },
      "fastExtract census parse failed",
    );
    throw new Error(
      "AI extraction: could not read the worker list from this file. Try again, or check the file is a readable timesheet.",
    );
  }
  if (workers.length === 0) {
    log?.warn(
      { customer, fileName, censusOutTokens: census.usage.outputTokens },
      "fastExtract census found zero workers",
    );
    return { rows: [], otherWorkers: [] };
  }

  // ---- Server-side matching: census vs the full fleet ----
  const { targets, strangers, laneCounts, laneSamples } = matchCensusToFleet(
    workers,
    roster,
  );
  log?.warn(
    {
      customer,
      fileName,
      censusWorkers: workers.length,
      matchedTargets: targets.length,
      strangers: strangers.length,
      laneCounts,
      laneSamples,
      censusMs: Date.now() - started,
      censusOutTokens: census.usage.outputTokens,
    },
    "fastExtract census + fleet match complete",
  );
  if (targets.length === 0) {
    // Nobody on the sheet matches the fleet — no extract call needed. The
    // route turns this into an honest error that names who WAS on the sheet.
    return { rows: [], otherWorkers: strangers };
  }

  // ---- Pass 2: extract punches for exactly the matched workers ----
  const extractStarted = Date.now();
  const { text, usage } = await client.generate({
    parts: [
      ...parts,
      { kind: "text", text: buildExtractPrompt(customer, weekStart, weekEnd, targets) },
    ],
    maxOutputTokens: 32768,
    timeoutMs: 180_000,
  });
  const { rows } = parseOrSalvage(stripToJson(text), customer, fileName, log);
  const out: AiExtractedRow[] = rows ?? [];
  if (usage.outputTokens >= 32_000) {
    log?.warn(
      { customer, fileName, outTokens: usage.outputTokens, rows: out.length },
      "fastExtract output near token cap — response likely truncated",
    );
  }
  log?.warn(
    {
      customer,
      fileName,
      rows: out.length,
      ms: Date.now() - started,
      extractMs: Date.now() - extractStarted,
      model: usage.model,
      outTokens: usage.outputTokens,
    },
    "fastExtract two-call complete",
  );
  return { rows: out, otherWorkers: strangers };
}
