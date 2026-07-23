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
 * Matching philosophy: the AI READS, the app MATCHES. The model extracts
 * EVERY worker on the sheet (skipping nobody), tagging the ones that
 * clearly match the expected-driver hints with `resolvedKfiId`. Server-side
 * resolution (`resolveKfiId`) then decides which rows are KFI drivers;
 * anything unresolved surfaces in the preview's picker instead of being
 * dropped. The roster is a HINT for id/spelling accuracy — never a filter:
 * a filter turns "driver tagged to the wrong customer in the DB" into a
 * silent 0-punch dead end (the IWG El Paso failure, 2026-07-23).
 * Expected drivers are emitted FIRST so if a monster sheet ever hits the
 * output-token cap, the truncated tail only loses non-KFI strangers.
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
    `IMPORTANT — extract EVERY worker on the sheet. Do not skip anyone: KFI's drivers are mixed in with the customer's other workers under names/ids you may not recognize, and the app decides afterwards which rows are KFI's. A worker you omit can never be recovered.`,
    ``,
    `For each worker's daily punch, output an object with:`,
    `- driverNameOnDoc: the worker's name exactly as written on the sheet.`,
    `- badgeOrId: the worker's id/badge/employee-number on the sheet, if any.`,
    `- date: YYYY-MM-DD (use the pay week to fill in the year if the sheet shows only M/D).`,
    `- hours: the day's worked hours as a decimal. USE THE SHEET'S OWN Total/Hours/Duration COLUMN when present — it already nets unpaid breaks and the customer's rounding. If a single day is split across pay-category rows (Reg + OT 1.5 + …), SUM them into one number for that day.`,
    `- timeIn / timeOut: clock in/out as "H:MM AM" / "H:MM PM" when shown; omit if only totals are given.`,
    `- resolvedKfiId: ONLY when the worker clearly matches one of the EXPECTED KFI DRIVERS listed at the end — by badge/alias, or by name when it's clearly the same person (e.g. "Choncoa, Ashley M" -> "Ashley Choncoa") — copy that driver's KFI id here. For every other worker, omit this field entirely; never guess.`,
    ``,
    `Emit ONE object per worker per day. Skip column headers, blank rows, page footers, and any total/subtotal/grand-total rows.`,
    `Output the rows for EXPECTED KFI DRIVERS first, then every other worker.`,
    ``,
    `Return ONLY raw JSON of the form {"rows":[ {…}, {…} ]}. No markdown fences, no prose before or after. Do not invent rows, workers, dates, or hours that aren't on the sheet.`,
  ];
  if (roster && roster.drivers.length > 0) {
    lines.push(
      "",
      `EXPECTED KFI DRIVERS (matching hints only — still extract every worker NOT on this list):`,
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
      `(No expected-driver list was provided — extract every worker's punches and a human will map them.)`,
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
): Promise<{ rows: AiExtractedRow[]; budgetSummary?: IngestionBudgetSummary }> {
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
  const { rows } = parseOrSalvage(text, customer, fileName, log);
  const out: AiExtractedRow[] = rows ?? [];
  // Near the 32k output cap → the model likely got cut off mid-list. The
  // prompt orders expected KFI drivers first so a truncated tail loses only
  // non-KFI workers, but flag it loudly so a short import is explainable.
  if (usage.outputTokens >= 32_000) {
    log?.warn(
      { customer, fileName, outTokens: usage.outputTokens, rows: out.length },
      "fastExtract output near token cap — sheet likely truncated (expected drivers were emitted first)",
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
  return { rows: out };
}
