import * as XLSX from "xlsx";
import type { ContentPart } from "./modelClient.js";
import { ClaudeModelClient } from "./claude.js";
import { normalizeImageBuffer } from "./imageSupport.js";
import {
  parseOrSalvage,
  type AiExtractedRow,
  type RosterContext,
} from "./aiExtract.js";
import { nameSimilarity } from "./fuzzy.js";
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
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
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
 * kfiId; fuzzy ≥0.72 → borderline (extract WITHOUT an id so the preview
 * picker decides); below → stranger (names surface in `otherWorkers`).
 * The roster is always the FULL active fleet — customer tags never gate.
 */
function matchCensusToFleet(
  workers: CensusWorker[],
  roster: RosterContext | undefined,
): {
  targets: Array<{ name: string; badge: string | null; kfiId: string | null }>;
  strangers: string[];
} {
  const drivers = roster?.drivers ?? [];
  if (drivers.length === 0) {
    // No fleet context — extract everyone and let the picker sort it out.
    return {
      targets: workers.map((w) => ({ name: w.name, badge: w.badge, kfiId: null })),
      strangers: [],
    };
  }
  const byBadge = new Map<string, string>();
  for (const d of drivers) {
    byBadge.set(d.kfiId.toLowerCase(), d.kfiId);
    for (const b of d.badges) byBadge.set(b.trim().toLowerCase(), d.kfiId);
    for (const a of d.aliases) byBadge.set(a.trim().toLowerCase(), d.kfiId);
  }
  const targets: Array<{ name: string; badge: string | null; kfiId: string | null }> = [];
  const strangers: string[] = [];
  for (const w of workers) {
    const badge = (w.badge ?? "").trim();
    const badgeHit = badge ? byBadge.get(badge.toLowerCase()) : undefined;
    // Alias tables may also key on the doc's name spelling (saved picker
    // decisions are folded into `aliases` by buildRosterContext).
    const nameHit = byBadge.get(w.name.trim().toLowerCase());
    if (badgeHit || nameHit) {
      targets.push({ name: w.name, badge: w.badge, kfiId: badgeHit ?? nameHit ?? null });
      continue;
    }
    let bestScore = 0;
    let bestKfi: string | null = null;
    for (const d of drivers) {
      const s = nameSimilarity(w.name, d.name);
      if (s > bestScore) {
        bestScore = s;
        bestKfi = d.kfiId;
      }
    }
    if (bestScore >= 0.85) {
      targets.push({ name: w.name, badge: w.badge, kfiId: bestKfi });
    } else if (bestScore >= 0.72) {
      // Close enough that a human should look — extract, no id, picker decides.
      targets.push({ name: w.name, badge: w.badge, kfiId: null });
    } else {
      strangers.push(w.badge ? `${w.name} (${w.badge})` : w.name);
    }
  }
  return { targets, strangers };
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
  const { targets, strangers } = matchCensusToFleet(workers, roster);
  log?.warn(
    {
      customer,
      fileName,
      censusWorkers: workers.length,
      matchedTargets: targets.length,
      strangers: strangers.length,
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
