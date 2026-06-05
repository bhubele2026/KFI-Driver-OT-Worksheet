import type Anthropic from "@anthropic-ai/sdk";
import type {
  CopilotToolStep,
  CopilotPendingAction,
} from "@workspace/db/schema";
import type { LoopbackCall } from "./loopback.js";

/**
 * Task #451: tool layer for the Worksheet Copilot. Each tool is a thin
 * wrapper over an existing `/api` endpoint, executed via {@link LoopbackCall}.
 * No business logic is re-implemented here — the tools resolve context
 * (week/driver), forward arguments, and translate HTTP results back into
 * compact text Claude can reason over.
 */

// Multi-step agentic work needs more headroom than the upload chat.
export const COPILOT_MAX_TOOL_CALLS = 28;
// Total bytes of tool-result text returned to Claude per turn.
export const COPILOT_MAX_RESULT_BYTES = 220_000;
// Per-call cap so one fat read can't crowd out the rest.
export const COPILOT_PER_RESULT_BYTES = 30_000;
// Bulk add over this many punches requires explicit confirmation.
export const COPILOT_BULK_CONFIRM_THRESHOLD = 5;

export class ToolBudget {
  callsUsed = 0;
  bytesUsed = 0;

  tryConsumeCall(): string | null {
    if (this.callsUsed >= COPILOT_MAX_TOOL_CALLS) {
      return `Tool-call budget exhausted for this turn (max ${COPILOT_MAX_TOOL_CALLS}). Summarize what you found and ask the dispatcher how to proceed.`;
    }
    this.callsUsed++;
    return null;
  }

  clampResult(text: string): string {
    let out = text;
    if (out.length > COPILOT_PER_RESULT_BYTES) {
      out =
        out.slice(0, COPILOT_PER_RESULT_BYTES) +
        `\n…[truncated to ${COPILOT_PER_RESULT_BYTES} chars]`;
    }
    if (this.bytesUsed + out.length > COPILOT_MAX_RESULT_BYTES) {
      const remaining = Math.max(0, COPILOT_MAX_RESULT_BYTES - this.bytesUsed);
      out =
        out.slice(0, remaining) +
        `\n…[result-byte budget exhausted for this turn]`;
    }
    this.bytesUsed += out.length;
    return out;
  }
}

export interface CopilotToolCtx {
  call: LoopbackCall;
  context: { weekStart?: string | null; kfiId?: string | null };
  user: { id: number; isAdmin: boolean };
  budget: ToolBudget;
  steps: CopilotToolStep[];
  /** Whether any read tool has run this turn (read-before-write guard). */
  hasRead: boolean;
}

export interface ToolOutcome {
  resultText: string;
  isError?: boolean;
  mutating: boolean;
  /** Set when the tool is a confirmation-gated action awaiting the user. */
  pending?: CopilotPendingAction;
}

// ---- tool metadata --------------------------------------------------------

const READ_TOOLS = new Set([
  "list_weeks",
  "get_week_summary",
  "get_driver_detail",
  "get_driver_roster",
  "lookup_driver",
  "get_customers",
  "get_ingestion_runs",
]);

// Mutations that always require an explicit confirmation card before running.
const GATED_TOOLS = new Set([
  "delete_punch",
  "refresh_connecteam_week",
  "remove_connecteam_time",
]);

const ADMIN_TOOLS = new Set([
  "add_driver_id_alias",
  "get_ingestion_runs",
]);

// ---- small helpers --------------------------------------------------------

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function resolveWeek(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): string | null {
  return str(input, "weekStart") ?? ctx.context.weekStart ?? null;
}

function resolveKfi(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): string | null {
  return str(input, "kfiId") ?? ctx.context.kfiId ?? null;
}

function describeError(r: { status: number; json: unknown; text: string }): string {
  const msg =
    (r.json &&
      typeof r.json === "object" &&
      "error" in r.json &&
      typeof (r.json as { error: unknown }).error === "string" &&
      (r.json as { error: string }).error) ||
    r.text ||
    "(no body)";
  switch (r.status) {
    case 401:
      return `Not authenticated (401). The dispatcher's session may have expired.`;
    case 403:
      return `Forbidden (403): ${msg}. This action needs a higher role; tell the dispatcher it requires an admin/supervisor.`;
    case 404:
      return `Not found (404): ${msg}. Re-check the week/driver/punch id with a read tool.`;
    case 409:
      return `Conflict (409): ${msg}. The driver-week is likely locked — unlock it first or tell the dispatcher.`;
    case 422:
    case 400:
      return `Rejected (${r.status}): ${msg}. Fix the inputs and retry.`;
    default:
      return `Request failed (${r.status}): ${msg}.`;
  }
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---- tool definitions (sent to Claude) ------------------------------------

export function buildCopilotToolDefs(): Anthropic.Messages.Tool[] {
  const optWeek = {
    weekStart: {
      type: "string" as const,
      description:
        "Payroll week start (Sunday, YYYY-MM-DD). Omit to use the dispatcher's current week.",
    },
  };
  const optKfi = {
    kfiId: {
      type: "string" as const,
      description:
        "Driver KFI id. Omit to use the dispatcher's current driver, if any.",
    },
  };
  return [
    {
      name: "list_weeks",
      description: "List all payroll weeks with driver counts and date ranges.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_week_summary",
      description:
        "Per-driver totals for a week with OT, customer/driver parity, review status, lock state, and who last touched each row. Read this before changing anything in a week.",
      input_schema: { type: "object", properties: { ...optWeek } },
    },
    {
      name: "get_driver_detail",
      description:
        "Full detail for one driver-week: punches grouped by date, daily totals, and validation alerts (missing punch, negative duration, overlap). Read this before editing a driver's punches.",
      input_schema: {
        type: "object",
        properties: { ...optWeek, ...optKfi },
      },
    },
    {
      name: "get_driver_roster",
      description: "The full KFI driver roster (kfiId, name, customer).",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "lookup_driver",
      description:
        "Resolve a driver name (or partial) or id to KFI driver records. Use to turn a name the dispatcher typed into a kfiId before acting.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Name, partial name, or id to resolve.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_customers",
      description: "The customer roster (display names, active state).",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_ingestion_runs",
      description:
        "Recent AI ingestion runs (admin only): per-upload token/cost/outcome history.",
      input_schema: { type: "object", properties: {} },
    },
    // ---- mutations ----
    {
      name: "add_manual_punch",
      description:
        "Add one manual punch for a driver on a date. Times are wall-clock like '7:30a' or '16:00'.",
      input_schema: {
        type: "object",
        properties: {
          ...optWeek,
          ...optKfi,
          date: { type: "string", description: "YYYY-MM-DD within the week." },
          clockIn: { type: "string" },
          clockOut: { type: "string" },
          payType: { type: "string", enum: ["Reg", "OT"] },
        },
        required: ["date", "clockIn", "clockOut"],
      },
    },
    {
      name: "bulk_add_punches",
      description:
        "Add many manual punches at once (e.g. a whole week's schedule). Resolve each driver to a kfiId first with lookup_driver. Over the bulk threshold this is gated behind a confirmation card.",
      input_schema: {
        type: "object",
        properties: {
          weekStart: optWeek.weekStart,
          punches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kfiId: { type: "string" },
                date: { type: "string" },
                clockIn: { type: "string" },
                clockOut: { type: "string" },
                payType: { type: "string", enum: ["Reg", "OT"] },
              },
              required: ["kfiId", "date", "clockIn", "clockOut"],
            },
          },
        },
        required: ["punches"],
      },
    },
    {
      name: "edit_punch",
      description:
        "Edit an existing punch by id. Set clockIn/clockOut to change times (hours recompute), or set hours to override the daily total verbatim.",
      input_schema: {
        type: "object",
        properties: {
          punchId: { type: "number" },
          clockIn: { type: "string" },
          clockOut: { type: "string" },
          hours: { type: "number" },
        },
        required: ["punchId"],
      },
    },
    {
      name: "delete_punch",
      description:
        "Delete a punch by id. Destructive — gated behind a confirmation card. A deletion snapshot is always kept.",
      input_schema: {
        type: "object",
        properties: {
          punchId: { type: "number" },
          reason: { type: "string" },
        },
        required: ["punchId", "reason"],
      },
    },
    {
      name: "scale_hours",
      description:
        "Scale a driver's punches on one day to total a target number of hours.",
      input_schema: {
        type: "object",
        properties: {
          ...optWeek,
          ...optKfi,
          date: { type: "string" },
          totalHours: { type: "number" },
        },
        required: ["date", "totalHours"],
      },
    },
    {
      name: "reset_hours",
      description:
        "Reset a driver's day hours to the raw clock-in/clock-out computation.",
      input_schema: {
        type: "object",
        properties: { ...optWeek, ...optKfi, date: { type: "string" } },
        required: ["date"],
      },
    },
    {
      name: "shift_punches",
      description:
        "Shift all of a driver's punches in a week by an offset in hours (-12..12, e.g. 1 or -0.5), preserving duration. Supervisor/admin only.",
      input_schema: {
        type: "object",
        properties: {
          ...optWeek,
          ...optKfi,
          offsetHours: { type: "number" },
          source: {
            type: "string",
            enum: ["Driver", "Customer"],
            description: "Optional: limit to one source.",
          },
          customer: {
            type: "string",
            description: "Optional: limit to one customer's rows.",
          },
        },
        required: ["offsetHours"],
      },
    },
    {
      name: "refresh_connecteam_week",
      description:
        "Pull fresh Connecteam punches for the whole week. Bulk + destructive (wipes then re-imports Driver-source rows) — gated behind a confirmation card. Edited rows are preserved.",
      input_schema: { type: "object", properties: { ...optWeek } },
    },
    {
      name: "refresh_connecteam_driver",
      description:
        "Pull fresh Connecteam punches for one driver in the week. Edited rows are preserved.",
      input_schema: {
        type: "object",
        properties: { ...optWeek, ...optKfi },
        required: [],
      },
    },
    {
      name: "remove_connecteam_time",
      description:
        "Hard-delete all Connecteam (Driver-source, non-manual) punches for one driver-week. Destructive — gated behind a confirmation card. Manual and Customer-source rows are preserved.",
      input_schema: {
        type: "object",
        properties: { ...optWeek, ...optKfi },
        required: [],
      },
    },
    {
      name: "mark_reviewed",
      description: "Set a driver-week's review status to good, bad, or clear.",
      input_schema: {
        type: "object",
        properties: {
          ...optWeek,
          ...optKfi,
          status: { type: "string", enum: ["good", "bad", "clear"] },
        },
        required: ["status"],
      },
    },
    {
      name: "set_lock",
      description:
        "Lock or unlock a driver-week (supervisor/admin only). Locking blocks further edits.",
      input_schema: {
        type: "object",
        properties: {
          ...optWeek,
          ...optKfi,
          locked: { type: "boolean" },
        },
        required: ["locked"],
      },
    },
    {
      name: "add_note",
      description:
        "Attach a note to a specific punch row (notes must reference a punchId — read get_driver_detail first to find it).",
      input_schema: {
        type: "object",
        properties: {
          ...optWeek,
          ...optKfi,
          punchId: { type: "number" },
          text: { type: "string" },
        },
        required: ["punchId", "text"],
      },
    },
    {
      name: "set_driver_customer_override",
      description:
        "Override which customer a driver is grouped under (applies across weeks). Pass the kfiId and the customer to group them under.",
      input_schema: {
        type: "object",
        properties: {
          ...optKfi,
          customer: { type: "string" },
        },
        required: ["customer"],
      },
    },
    {
      name: "add_driver_id_alias",
      description:
        "Map an external driver id to a KFI id so future uploads resolve it (admin only).",
      input_schema: {
        type: "object",
        properties: {
          externalId: { type: "string" },
          kfiId: { type: "string" },
        },
        required: ["externalId", "kfiId"],
      },
    },
  ];
}

// ---- dispatch -------------------------------------------------------------

export async function runCopilotTool(
  name: string,
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const overBudget = ctx.budget.tryConsumeCall();
  if (overBudget) {
    return { resultText: overBudget, isError: true, mutating: false };
  }

  if (ADMIN_TOOLS.has(name) && !ctx.user.isAdmin) {
    return {
      resultText: `"${name}" is an admin-only action and the dispatcher is not an admin. Tell them this requires an admin.`,
      isError: true,
      mutating: false,
    };
  }

  const isRead = READ_TOOLS.has(name);
  const isMutation = !isRead;

  // Read-before-write: the copilot must ground itself before mutating.
  if (isMutation && !ctx.hasRead) {
    return {
      resultText: `Read the relevant data first (e.g. get_week_summary or get_driver_detail) before changing anything, so you act on the current state.`,
      isError: true,
      mutating: true,
    };
  }

  try {
    const outcome = await dispatch(name, input, ctx);
    // Only a *successful* read grounds the turn. A failed read (bad input,
    // no week in context, loopback non-2xx) must NOT unlock mutations —
    // otherwise the read-before-write rail can be bypassed by an erroring read.
    if (isRead && !outcome.isError) ctx.hasRead = true;
    return outcome;
  } catch (err) {
    return {
      resultText: `Tool "${name}" threw: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      mutating: isMutation,
    };
  }
}

function recordStep(
  ctx: CopilotToolCtx,
  step: CopilotToolStep,
): void {
  ctx.steps.push(step);
}

async function dispatch(
  name: string,
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  switch (name) {
    // ---- reads ----
    case "list_weeks":
      return read(ctx, name, input, "GET", "/api/weeks");
    case "get_week_summary": {
      const w = resolveWeek(input, ctx);
      if (!w) return needWeek(name, ctx, input);
      return read(
        ctx,
        name,
        input,
        "GET",
        `/api/weeks/${encodeURIComponent(w)}/summary`,
      );
    }
    case "get_driver_detail": {
      const w = resolveWeek(input, ctx);
      const k = resolveKfi(input, ctx);
      if (!w) return needWeek(name, ctx, input);
      if (!k) return needKfi(name, ctx, input);
      return read(
        ctx,
        name,
        input,
        "GET",
        `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}`,
      );
    }
    case "get_driver_roster":
      return read(ctx, name, input, "GET", "/api/drivers");
    case "get_customers":
      return read(ctx, name, input, "GET", "/api/admin/customers");
    case "get_ingestion_runs":
      return read(ctx, name, input, "GET", "/api/admin/ingestion-runs");
    case "lookup_driver":
      return lookupDriver(input, ctx);

    // ---- mutations ----
    case "add_manual_punch":
      return addManualPunch(input, ctx);
    case "bulk_add_punches":
      return bulkAddPunches(input, ctx);
    case "edit_punch":
      return editPunch(input, ctx);
    case "delete_punch":
      return deletePunch(input, ctx);
    case "scale_hours":
      return scaleHours(input, ctx);
    case "reset_hours":
      return resetHours(input, ctx);
    case "shift_punches":
      return shiftPunches(input, ctx);
    case "refresh_connecteam_week":
      return refreshConnecteamWeek(input, ctx);
    case "refresh_connecteam_driver":
      return refreshConnecteamDriver(input, ctx);
    case "remove_connecteam_time":
      return removeConnecteamTime(input, ctx);
    case "mark_reviewed":
      return markReviewed(input, ctx);
    case "set_lock":
      return setLock(input, ctx);
    case "add_note":
      return addNote(input, ctx);
    case "set_driver_customer_override":
      return setDriverCustomerOverride(input, ctx);
    case "add_driver_id_alias":
      return addDriverIdAlias(input, ctx);

    default:
      return {
        resultText: `Unknown tool "${name}".`,
        isError: true,
        mutating: false,
      };
  }
}

function needWeek(
  name: string,
  ctx: CopilotToolCtx,
  input: Record<string, unknown>,
): ToolOutcome {
  recordStep(ctx, {
    tool: name,
    input,
    ok: false,
    mutating: false,
    summary: "no week in context",
  });
  return {
    resultText:
      "No week is in context. Ask the dispatcher which payroll week, or pass weekStart (YYYY-MM-DD, a Sunday).",
    isError: true,
    mutating: false,
  };
}

function needKfi(
  name: string,
  ctx: CopilotToolCtx,
  input: Record<string, unknown>,
): ToolOutcome {
  recordStep(ctx, {
    tool: name,
    input,
    ok: false,
    mutating: false,
    summary: "no driver in context",
  });
  return {
    resultText:
      "No driver is in context. Resolve the driver with lookup_driver, then pass kfiId.",
    isError: true,
    mutating: false,
  };
}

// Generic read: GET an endpoint, clamp + return its JSON.
async function read(
  ctx: CopilotToolCtx,
  name: string,
  input: Record<string, unknown>,
  method: "GET",
  path: string,
): Promise<ToolOutcome> {
  const r = await ctx.call(method, path, undefined);
  if (!r.ok) {
    recordStep(ctx, {
      tool: name,
      input,
      ok: false,
      mutating: false,
      summary: `read failed (${r.status})`,
      status: r.status,
    });
    return { resultText: describeError(r), isError: true, mutating: false };
  }
  recordStep(ctx, {
    tool: name,
    input,
    ok: true,
    mutating: false,
    summary: "read ok",
    status: r.status,
  });
  return {
    resultText: ctx.budget.clampResult(jsonText(r.json)),
    mutating: false,
  };
}

async function lookupDriver(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const query = str(input, "query");
  if (!query) {
    return {
      resultText: "Pass a non-empty query.",
      isError: true,
      mutating: false,
    };
  }
  const r = await ctx.call("GET", "/api/drivers", undefined);
  if (!r.ok) {
    recordStep(ctx, {
      tool: "lookup_driver",
      input,
      ok: false,
      mutating: false,
      summary: `roster read failed (${r.status})`,
      status: r.status,
    });
    return { resultText: describeError(r), isError: true, mutating: false };
  }
  const roster = Array.isArray(r.json)
    ? (r.json as Array<Record<string, unknown>>)
    : [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = norm(query);
  const matches = roster
    .map((d) => {
      const name = typeof d.name === "string" ? d.name : "";
      const kfiId = typeof d.kfiId === "string" ? d.kfiId : String(d.kfiId ?? "");
      const nName = norm(name);
      const nId = norm(kfiId);
      let rank = -1;
      if (nId === q || nName === q) rank = 0;
      else if (nName.startsWith(q) || nId.startsWith(q)) rank = 1;
      else if (nName.includes(q) || nId.includes(q)) rank = 2;
      return { d, rank };
    })
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8)
    .map((m) => m.d);
  recordStep(ctx, {
    tool: "lookup_driver",
    input,
    ok: true,
    mutating: false,
    summary: `${matches.length} match(es)`,
    status: r.status,
  });
  ctx.hasRead = true;
  return {
    resultText: ctx.budget.clampResult(
      jsonText({ query, matches }),
    ),
    mutating: false,
  };
}

// Generic direct mutation: call, record, translate result.
async function directMutation(
  ctx: CopilotToolCtx,
  name: string,
  input: Record<string, unknown>,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  okSummary: string,
): Promise<ToolOutcome> {
  const r = await ctx.call(method, path, body);
  if (!r.ok) {
    recordStep(ctx, {
      tool: name,
      input,
      ok: false,
      mutating: true,
      summary: `failed (${r.status})`,
      status: r.status,
    });
    return { resultText: describeError(r), isError: true, mutating: true };
  }
  recordStep(ctx, {
    tool: name,
    input,
    ok: true,
    mutating: true,
    summary: okSummary,
    status: r.status,
  });
  return {
    resultText: ctx.budget.clampResult(
      `${okSummary}. ${jsonText(r.json)}`,
    ),
    mutating: true,
  };
}

function gated(
  ctx: CopilotToolCtx,
  name: string,
  input: Record<string, unknown>,
  action: CopilotPendingAction,
): ToolOutcome {
  recordStep(ctx, {
    tool: name,
    input,
    ok: true,
    mutating: true,
    summary: "queued for confirmation",
  });
  return {
    resultText: `Queued for the dispatcher's confirmation: ${action.title}. In one short sentence, tell them what will happen and that you're waiting for their confirmation. Do not call more tools.`,
    mutating: true,
    pending: action,
  };
}

// ---- individual mutation handlers ----

async function addManualPunch(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("add_manual_punch", ctx, input);
  if (!k) return needKfi("add_manual_punch", ctx, input);
  const date = str(input, "date");
  const clockIn = str(input, "clockIn");
  const clockOut = str(input, "clockOut");
  if (!date || !clockIn || !clockOut) {
    return {
      resultText: "add_manual_punch needs date, clockIn, and clockOut.",
      isError: true,
      mutating: true,
    };
  }
  const body: Record<string, unknown> = {
    kfiId: k,
    source: "Driver",
    date,
    clockIn,
    clockOut,
  };
  const payType = str(input, "payType");
  if (payType) body.payType = payType;
  return directMutation(
    ctx,
    "add_manual_punch",
    input,
    "POST",
    `/api/weeks/${encodeURIComponent(w)}/manual-punches`,
    body,
    `added manual punch for ${k} on ${date}`,
  );
}

async function bulkAddPunches(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  if (!w) return needWeek("bulk_add_punches", ctx, input);
  const rawPunches = input.punches;
  if (!Array.isArray(rawPunches) || rawPunches.length === 0) {
    return {
      resultText: "bulk_add_punches needs a non-empty punches array.",
      isError: true,
      mutating: true,
    };
  }
  const punches: Array<Record<string, unknown>> = [];
  for (const p of rawPunches) {
    if (!p || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    const kfiId = str(rec, "kfiId");
    const date = str(rec, "date");
    const clockIn = str(rec, "clockIn");
    const clockOut = str(rec, "clockOut");
    if (!kfiId || !date || !clockIn || !clockOut) {
      return {
        resultText: `Every punch needs kfiId, date, clockIn, clockOut. Offending row: ${jsonText(rec)}. Resolve names with lookup_driver first.`,
        isError: true,
        mutating: true,
      };
    }
    const row: Record<string, unknown> = {
      kfiId,
      source: "Driver",
      date,
      clockIn,
      clockOut,
    };
    const payType = str(rec, "payType");
    if (payType) row.payType = payType;
    punches.push(row);
  }

  const calls = punches.map((p) => ({
    method: "POST" as const,
    path: `/api/weeks/${encodeURIComponent(w)}/manual-punches`,
    body: p,
    label: `${p.kfiId} ${p.date} ${p.clockIn}-${p.clockOut}`,
  }));

  if (punches.length > COPILOT_BULK_CONFIRM_THRESHOLD) {
    return gated(ctx, "bulk_add_punches", input, {
      kind: "bulk_add_punches",
      title: `Add ${punches.length} manual punches`,
      summary: calls.map((c) => c.label),
      calls,
    });
  }

  // Under threshold: execute sequentially, reusing the manual-punch route.
  const results: string[] = [];
  let failures = 0;
  for (const c of calls) {
    const r = await ctx.call(c.method, c.path, c.body);
    if (!r.ok) {
      failures++;
      results.push(`FAILED ${c.label}: ${describeError(r)}`);
    } else {
      results.push(`ok ${c.label}`);
    }
  }
  recordStep(ctx, {
    tool: "bulk_add_punches",
    input,
    ok: failures === 0,
    mutating: true,
    summary: `${punches.length - failures}/${punches.length} added`,
  });
  return {
    resultText: ctx.budget.clampResult(results.join("\n")),
    isError: failures > 0,
    mutating: true,
  };
}

async function editPunch(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const punchId = num(input, "punchId");
  if (punchId === undefined) {
    return {
      resultText: "edit_punch needs a numeric punchId.",
      isError: true,
      mutating: true,
    };
  }
  const body: Record<string, unknown> = {};
  for (const key of ["clockIn", "clockOut"]) {
    const v = str(input, key);
    if (v) body[key] = v;
  }
  const hours = num(input, "hours");
  if (hours !== undefined) body.hours = hours;
  if (Object.keys(body).length === 0) {
    return {
      resultText: "edit_punch needs at least one of clockIn, clockOut, hours.",
      isError: true,
      mutating: true,
    };
  }
  return directMutation(
    ctx,
    "edit_punch",
    input,
    "PATCH",
    `/api/punches/${punchId}`,
    body,
    `edited punch ${punchId}`,
  );
}

function deletePunch(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): ToolOutcome {
  const punchId = num(input, "punchId");
  const reason = str(input, "reason");
  if (punchId === undefined || !reason) {
    return {
      resultText: "delete_punch needs a numeric punchId and a reason.",
      isError: true,
      mutating: true,
    };
  }
  return gated(ctx, "delete_punch", input, {
    kind: "delete_punch",
    title: `Delete punch ${punchId}`,
    summary: [`Delete punch ${punchId}`, `Reason: ${reason}`],
    calls: [
      {
        method: "DELETE",
        path: `/api/punches/${punchId}`,
        label: `delete punch ${punchId}`,
      },
    ],
  });
}

async function scaleHours(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("scale_hours", ctx, input);
  if (!k) return needKfi("scale_hours", ctx, input);
  const date = str(input, "date");
  const totalHours = num(input, "totalHours");
  if (!date || totalHours === undefined) {
    return {
      resultText: "scale_hours needs date and totalHours.",
      isError: true,
      mutating: true,
    };
  }
  return directMutation(
    ctx,
    "scale_hours",
    input,
    "POST",
    `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}/days/${encodeURIComponent(date)}/scale-hours`,
    { totalHours },
    `scaled ${k} on ${date} to ${totalHours}h`,
  );
}

async function resetHours(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("reset_hours", ctx, input);
  if (!k) return needKfi("reset_hours", ctx, input);
  const date = str(input, "date");
  if (!date) {
    return {
      resultText: "reset_hours needs a date.",
      isError: true,
      mutating: true,
    };
  }
  return directMutation(
    ctx,
    "reset_hours",
    input,
    "POST",
    `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}/days/${encodeURIComponent(date)}/reset-hours`,
    {},
    `reset ${k} hours on ${date}`,
  );
}

async function shiftPunches(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("shift_punches", ctx, input);
  if (!k) return needKfi("shift_punches", ctx, input);
  const offsetHours = num(input, "offsetHours");
  if (offsetHours === undefined || offsetHours === 0) {
    return {
      resultText: "shift_punches needs a non-zero offsetHours (-12..12).",
      isError: true,
      mutating: true,
    };
  }
  const body: Record<string, unknown> = { offsetHours };
  const source = str(input, "source");
  if (source) body.source = source;
  const customer = str(input, "customer");
  if (customer) body.customer = customer;
  return directMutation(
    ctx,
    "shift_punches",
    input,
    "POST",
    `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}/shift-punches`,
    body,
    `shifted ${k} punches by ${offsetHours}h`,
  );
}

function refreshConnecteamWeek(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): ToolOutcome {
  const w = resolveWeek(input, ctx);
  if (!w) return needWeek("refresh_connecteam_week", ctx, input);
  return gated(ctx, "refresh_connecteam_week", input, {
    kind: "refresh_connecteam_week",
    title: `Refresh Connecteam for the whole week ${w}`,
    summary: [
      `Re-import Driver-source punches for every driver in ${w}`,
      "Edited rows are preserved",
    ],
    calls: [
      {
        method: "POST",
        path: `/api/weeks/${encodeURIComponent(w)}/refresh-connecteam`,
        label: `refresh week ${w}`,
      },
    ],
  });
}

async function refreshConnecteamDriver(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("refresh_connecteam_driver", ctx, input);
  if (!k) return needKfi("refresh_connecteam_driver", ctx, input);
  return directMutation(
    ctx,
    "refresh_connecteam_driver",
    input,
    "POST",
    `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}/refresh-connecteam`,
    {},
    `refreshed Connecteam for ${k} in ${w}`,
  );
}

function removeConnecteamTime(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): ToolOutcome {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("remove_connecteam_time", ctx, input);
  if (!k) return needKfi("remove_connecteam_time", ctx, input);
  return gated(ctx, "remove_connecteam_time", input, {
    kind: "remove_connecteam_time",
    title: `Remove Connecteam time for ${k} in ${w}`,
    summary: [
      `Hard-delete all Driver-source (non-manual) punches for ${k} in ${w}`,
      "Manual and Customer-source rows are preserved; deleted rows are snapshotted",
    ],
    calls: [
      {
        method: "POST",
        path: `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}/remove-connecteam-time`,
        body: { confirm: k },
        label: `remove Connecteam time for ${k}`,
      },
    ],
  });
}

async function markReviewed(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("mark_reviewed", ctx, input);
  if (!k) return needKfi("mark_reviewed", ctx, input);
  const status = str(input, "status");
  if (!status || !["good", "bad", "clear"].includes(status)) {
    return {
      resultText: "mark_reviewed status must be good, bad, or clear.",
      isError: true,
      mutating: true,
    };
  }
  const body = { status: status === "clear" ? null : status };
  return directMutation(
    ctx,
    "mark_reviewed",
    input,
    "PUT",
    `/api/weeks/${encodeURIComponent(w)}/reviewed/${encodeURIComponent(k)}`,
    body,
    `marked ${k} reviewed=${status}`,
  );
}

async function setLock(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("set_lock", ctx, input);
  if (!k) return needKfi("set_lock", ctx, input);
  const locked = input.locked;
  if (typeof locked !== "boolean") {
    return {
      resultText: "set_lock needs a boolean locked.",
      isError: true,
      mutating: true,
    };
  }
  return directMutation(
    ctx,
    "set_lock",
    input,
    locked ? "POST" : "DELETE",
    `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}/lock`,
    locked ? {} : undefined,
    `${locked ? "locked" : "unlocked"} ${k} in ${w}`,
  );
}

async function addNote(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const w = resolveWeek(input, ctx);
  const k = resolveKfi(input, ctx);
  if (!w) return needWeek("add_note", ctx, input);
  if (!k) return needKfi("add_note", ctx, input);
  const text = str(input, "text");
  const punchId = num(input, "punchId");
  if (!text) {
    return {
      resultText: "add_note needs text.",
      isError: true,
      mutating: true,
    };
  }
  if (punchId === undefined) {
    return {
      resultText:
        "add_note needs a punchId — notes attach to a specific punch. Read get_driver_detail to find the punch id.",
      isError: true,
      mutating: true,
    };
  }
  return directMutation(
    ctx,
    "add_note",
    input,
    "POST",
    `/api/weeks/${encodeURIComponent(w)}/drivers/${encodeURIComponent(k)}/notes`,
    { body: text, punchId },
    `added note on punch ${punchId} for ${k}`,
  );
}

async function setDriverCustomerOverride(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const k = resolveKfi(input, ctx);
  if (!k) return needKfi("set_driver_customer_override", ctx, input);
  const customer = str(input, "customer");
  if (!customer) {
    return {
      resultText: "set_driver_customer_override needs a customer.",
      isError: true,
      mutating: true,
    };
  }
  return directMutation(
    ctx,
    "set_driver_customer_override",
    input,
    "POST",
    `/api/driver-customer-overrides`,
    { kfiId: k, overrideCustomer: customer },
    `set ${k} customer override to ${customer}`,
  );
}

async function addDriverIdAlias(
  input: Record<string, unknown>,
  ctx: CopilotToolCtx,
): Promise<ToolOutcome> {
  const externalId = str(input, "externalId");
  const kfiId = str(input, "kfiId");
  if (!externalId || !kfiId) {
    return {
      resultText: "add_driver_id_alias needs externalId and kfiId.",
      isError: true,
      mutating: true,
    };
  }
  return directMutation(
    ctx,
    "add_driver_id_alias",
    input,
    "POST",
    `/api/driver-id-aliases`,
    { externalId, kfiId },
    `aliased external id ${externalId} → ${kfiId}`,
  );
}

export const _toolInternals = {
  READ_TOOLS,
  GATED_TOOLS,
  ADMIN_TOOLS,
};
