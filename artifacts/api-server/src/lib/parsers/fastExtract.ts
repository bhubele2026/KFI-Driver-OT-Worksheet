import * as XLSX from "xlsx";
import type { ContentPart } from "./modelClient.js";
import { ClaudeModelClient } from "./claude.js";
import { normalizeImageBuffer } from "./imageSupport.js";
import {
  parseOrSalvage,
  type AiExtractedRow,
  type RosterContext,
} from "./aiExtract.js";
import type { SalvageLogger } from "./jsonSalvage.js";
import type { IngestionBudgetSummary } from "./ingestionBudget.js";

/**
 * Clean-slate customer-timesheet extraction: ONE model call per file, no
 * chunking, no schema cache, no pacer. Drop-in replacement for the old
 * `aiExtractRows` (same signature + return), so all the downstream
 * matching / review / confirm logic in `extractImageForKnownCustomer` is
 * reused unchanged.
 *
 * Matching philosophy: the AI READS, the app MATCHES — with bounded output.
 * The expected-driver hints are the FULL active fleet (never narrowed to a
 * customer tag: narrowing turned "driver tagged to the wrong customer in
 * the DB" into a silent 0-punch dead end — the IWG El Paso failure,
 * 2026-07-23). The model emits punch rows for every worker who plausibly
 * matches the fleet (unsure → row WITHOUT resolvedKfiId, so the picker
 * decides), and lists every remaining worker by NAME ONLY in
 * `otherWorkers`. That keeps output tokens small on 500-row sheets (a
 * full extract-everyone attempt blew the 180s timeout mid-JSON) while
 * guaranteeing nobody on the sheet is invisible: worst case the server
 * can say exactly which workers it saw and didn't recognize.
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
    return [{ kind: "text", text: blocks.join("\n\n") }];
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
  return [{ kind: "text", text: buffer.toString("utf8").slice(0, 200_000) }];
}

/** Extract-everyone prompt (roster is a hint, never a filter). Output is the AiExtractedRow shape. */
function buildFastPrompt(
  customer: string,
  weekStart: string,
  weekEnd: string,
  roster?: RosterContext,
): string {
  const lines = [
    `You extract timecard punches for KFI Staffing from a customer's timesheet.`,
    `Customer: "${customer}". Pay week: ${weekStart} through ${weekEnd} (Sunday–Saturday). Only include rows whose date is in that window.`,
    ``,
    `The sheet mixes KFI's drivers in with the customer's other workers. Extract punch rows for every worker whose name or badge matches one of the EXPECTED KFI DRIVERS listed at the end. Match names loosely and decisively — "Choncoa, Ashley M" is "Ashley Choncoa"; middle names, initials, and accents vary; a shared surname or a close spelling counts as a match (include the rows, leave resolvedKfiId out, a human decides). Do not deliberate: one quick pass per worker — resembles someone on the list → extract their rows; otherwise → their name goes in otherWorkers.`,
    ``,
    `For each extracted worker's daily punch, output an object with:`,
    `- driverNameOnDoc: the worker's name exactly as written on the sheet.`,
    `- badgeOrId: the worker's id/badge/employee-number on the sheet, if any.`,
    `- date: YYYY-MM-DD (use the pay week to fill in the year if the sheet shows only M/D).`,
    `- hours: the day's worked hours as a decimal. USE THE SHEET'S OWN Total/Hours/Duration COLUMN when present — it already nets unpaid breaks and the customer's rounding. If a single day is split across pay-category rows (Reg + OT 1.5 + …), SUM them into one number for that day.`,
    `- timeIn / timeOut: clock in/out as "H:MM AM" / "H:MM PM" when shown; omit if only totals are given.`,
    `- resolvedKfiId: the matched driver's KFI id from the list — but ONLY when the match is clear. If the worker plausibly matches yet you're unsure which driver (or whether it's really them), still output their rows and omit this field; never guess an id.`,
    ``,
    `Emit ONE object per extracted worker per day. Skip column headers, blank rows, page footers, and any total/subtotal/grand-total rows.`,
    ``,
    `Then "otherWorkers": the workers you did NOT extract, names only ("Name (badge)" or "Name"), no duplicates. List at most 30; if there are more, make the final entry "+N more" with N = how many you left off. Do not list them all.`,
    ``,
    `Return ONLY raw JSON of the form {"rows":[ {…} ], "otherWorkers":["…"]}. Put "rows" first. Start your reply with "{" — no markdown fences, no prose, no explanation before or after the JSON. Do not invent rows, workers, dates, or hours that aren't on the sheet.`,
  ];
  if (roster && roster.drivers.length > 0) {
    lines.push(
      "",
      `EXPECTED KFI DRIVERS (the full fleet — a driver may show up at ANY customer):`,
    );
    for (const d of roster.drivers.slice(0, 300)) {
      const parts = [`${d.kfiId}: ${d.name}`];
      if (d.badges.length) parts.push(`badges=[${d.badges.join(", ")}]`);
      if (d.aliases.length) parts.push(`aliases=[${d.aliases.join(", ")}]`);
      lines.push(`- ${parts.join("; ")}`);
    }
  } else {
    lines.push(
      "",
      `(No expected-driver list was provided — extract every worker's punches, leave resolvedKfiId out, and a human will map them. otherWorkers should be empty.)`,
    );
  }
  return lines.join("\n");
}

/**
 * Single-call extraction. Same signature/return as the old `aiExtractRows`
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
  const prompt = buildFastPrompt(customer, weekStart, weekEnd, roster);
  const client = new ClaudeModelClient(); // uses CLAUDE_EXTRACT_MODEL (Sonnet 5)
  const started = Date.now();
  const { text, usage } = await client.generate({
    parts: [...parts, { kind: "text", text: prompt }],
    maxOutputTokens: 32768,
    timeoutMs: 180_000,
  });
  // Models occasionally narrate before the JSON despite the contract
  // ("Looking at the timesheet…"). Strip anything before the first "{"
  // so a prose prefix can't sink an otherwise-good response.
  const braceAt = text.indexOf("{");
  const jsonText = braceAt > 0 ? text.slice(braceAt) : text;
  const { rows } = parseOrSalvage(jsonText, customer, fileName, log);
  const out: AiExtractedRow[] = rows ?? [];
  // Best-effort read of the names-only stranger list. It rides in the same
  // JSON object AFTER "rows", so a truncated response loses strangers first
  // and this parse just yields [] (parseOrSalvage already rescued the rows).
  let otherWorkers: string[] = [];
  try {
    const full = JSON.parse(jsonText) as { otherWorkers?: unknown };
    if (Array.isArray(full.otherWorkers)) {
      otherWorkers = full.otherWorkers
        .filter((w): w is string => typeof w === "string" && w.trim().length > 0)
        .map((w) => w.trim())
        .slice(0, 500);
    }
  } catch {
    // salvaged/truncated response — stranger names unavailable, rows stand.
  }
  // Near the 32k output cap → the model likely got cut off mid-list. Rows
  // come first in the output, so the loss lands on otherWorkers, but flag
  // it loudly so a short import is explainable.
  if (usage.outputTokens >= 32_000) {
    log?.warn(
      { customer, fileName, outTokens: usage.outputTokens, rows: out.length },
      "fastExtract output near token cap — response likely truncated (rows were emitted first)",
    );
  }
  log?.warn(
    {
      customer,
      fileName,
      rows: out.length,
      ms: Date.now() - started,
      model: usage.model,
      outTokens: usage.outputTokens,
    },
    "fastExtract single-call complete",
  );
  return { rows: out, otherWorkers };
}
