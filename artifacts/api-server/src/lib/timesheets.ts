import type { RequestHandler } from "express";
import type { Driver, Punch } from "@workspace/db/schema";
import {
  computeChecks,
  computeDriverTotals,
  type PunchCheck,
} from "./hoursEngine.js";
import { isoDateToUtcMs, localStrToSortMs, weekEndOf } from "./time.js";
import { KNOWN_CUSTOMERS } from "./parsers/index.js";
import { looksLikeRosterDateJunk } from "./connecteam.js";

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

export const UNASSIGNED_CUSTOMER = "Needs roster cleanup";

export interface TimesheetRow {
  date: string;
  source: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  after: number;
  rtPortion: number;
  otPortion: number;
  isManual: boolean;
  edited: boolean;
}

export interface TimesheetSheet {
  kfiId: string;
  name: string;
  customer: string;
  customerLabel: string;
  totals: ReturnType<typeof computeDriverTotals>;
  rows: TimesheetRow[];
  checks: PunchCheck[];
}

const customerKey = (c: string | null | undefined): string => {
  const trimmed = (c ?? "").trim();
  if (
    !trimmed ||
    trimmed === "Unknown" ||
    trimmed.toLowerCase() === "[object object]" ||
    looksLikeRosterDateJunk(trimmed)
  ) {
    return UNASSIGNED_CUSTOMER;
  }
  return trimmed;
};

export interface BuildTimesheetsOptions {
  /** When set, only drivers whose kfiId is in this set are included
   * (drives the "Reviewed only" print mode). */
  reviewedKfiIds?: ReadonlySet<string> | null;
  /** When set (non-empty string), only drivers whose customer key matches
   * this value are included (drives the per-customer print mode). */
  customerFilter?: string | null;
}

/**
 * Build the per-driver timesheet sections for a week. The output mirrors the
 * dashboard sidebar order (KNOWN_CUSTOMERS first, then unknown customers
 * alphabetically, then the "Needs roster cleanup" bucket; drivers within a
 * customer sort by name) and the per-driver running total / RT-OT split that
 * the driver-detail page renders.
 */
export function buildTimesheets(
  punches: Punch[],
  drivers: Driver[],
  options: BuildTimesheetsOptions = {},
): TimesheetSheet[] {
  const driverById = new Map(drivers.map((d) => [d.kfiId, d]));
  const byKfi = new Map<string, Punch[]>();
  for (const p of punches) {
    const arr = byKfi.get(p.kfiId) ?? [];
    arr.push(p);
    byKfi.set(p.kfiId, arr);
  }

  const knownOrder = new Map<string, number>(
    KNOWN_CUSTOMERS.map((c, i) => [c.displayName, i]),
  );
  const customerFilterKey =
    options.customerFilter && options.customerFilter.trim().length > 0
      ? customerKey(options.customerFilter)
      : null;

  const sheets: TimesheetSheet[] = [];
  for (const [kfiId, ps] of byKfi.entries()) {
    const totals = computeDriverTotals(ps);
    if (totals.totalHours <= 0) continue;
    if (options.reviewedKfiIds && !options.reviewedKfiIds.has(kfiId)) continue;
    const meta = driverById.get(kfiId);
    if (customerFilterKey) {
      const driverCustomerKey = customerKey(
        meta?.customer ?? ps[0]?.customer ?? "Unknown",
      );
      if (driverCustomerKey !== customerFilterKey) continue;
    }
    const sortedPs = [...ps].sort((a, b) => {
      const ta = localStrToSortMs(a.clockIn) ?? isoDateToUtcMs(a.date);
      const tb = localStrToSortMs(b.clockIn) ?? isoDateToUtcMs(b.date);
      return ta - tb;
    });
    let running = 0;
    const rows: TimesheetRow[] = sortedPs.map((p) => {
      const before = running;
      const h = Number(p.hours) || 0;
      running = before + h;
      const otBefore = Math.max(0, before - 40);
      const otAfter = Math.max(0, running - 40);
      const otPortion = otAfter - otBefore;
      const rtPortion = h - otPortion;
      return {
        date: p.date,
        source: p.source,
        clockIn: formatClockCell(p.clockIn),
        clockOut: formatClockCell(p.clockOut),
        hours: h,
        after: running,
        rtPortion,
        otPortion,
        isManual: !!p.isManual,
        edited: !!p.edited,
      };
    });
    const customer = meta?.customer ?? ps[0]?.customer ?? "Unknown";
    sheets.push({
      kfiId,
      name: meta?.name ?? `Driver ${kfiId}`,
      customer,
      customerLabel:
        customerKey(customer) === UNASSIGNED_CUSTOMER
          ? UNASSIGNED_CUSTOMER
          : customer,
      totals,
      rows,
      checks: computeChecks(ps),
    });
  }

  const presentCustomers = new Set(sheets.map((s) => customerKey(s.customer)));
  const orderedCustomers: string[] = [];
  for (const c of KNOWN_CUSTOMERS) {
    if (presentCustomers.has(c.displayName)) orderedCustomers.push(c.displayName);
  }
  const extras = [...presentCustomers]
    .filter((c) => c !== UNASSIGNED_CUSTOMER && !knownOrder.has(c))
    .sort((a, b) => a.localeCompare(b));
  orderedCustomers.push(...extras);
  if (presentCustomers.has(UNASSIGNED_CUSTOMER)) {
    orderedCustomers.push(UNASSIGNED_CUSTOMER);
  }
  const customerOrderIdx = new Map<string, number>(
    orderedCustomers.map((c, i) => [c, i]),
  );
  sheets.sort((a, b) => {
    const ka = customerKey(a.customer);
    const kb = customerKey(b.customer);
    const ra = customerOrderIdx.get(ka) ?? Number.MAX_SAFE_INTEGER;
    const rb = customerOrderIdx.get(kb) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  return sheets;
}

export interface RenderTimesheetsOptions {
  weekStart: string;
  endDate: string;
  sheets: TimesheetSheet[];
  lastRefreshedAt?: Date | string | null;
  /** "Reviewed only" print mode — annotates the title and the doc meta line. */
  reviewedOnly?: boolean;
  /** Per-customer print mode — annotates the title and the doc meta line. */
  customerFilter?: string | null;
}

export interface TimesheetWeekMeta {
  endDate: string;
  lastRefreshedAt: Date | string | null;
}

export interface TimesheetLoaders {
  getWeek: (weekStart: string) => Promise<TimesheetWeekMeta | null>;
  getPunches: (weekStart: string) => Promise<Punch[]>;
  getDrivers: () => Promise<Driver[]>;
  /** Optional loader that returns the set of reviewed driver kfiIds for a
   * given week. When omitted, the `?filter=reviewed` query param is ignored. */
  getReviewedKfiIds?: (weekStart: string) => Promise<ReadonlySet<string>>;
}

/** Build the Express request handler for `GET /weeks/:weekStart/timesheets`.
 * Loaders are injectable so the route can be exercised end-to-end in tests
 * without a live database. Honors `?filter=reviewed` and `?customer=` query
 * params for the per-customer / reviewed-only print modes. */
export function makeTimesheetsHandler(
  loaders: TimesheetLoaders,
): RequestHandler<{ weekStart: string }> {
  return async (req, res) => {
    const weekStart = req.params.weekStart;
    if (!WEEK_RE.test(weekStart)) {
      res.status(400).send("Invalid week");
      return;
    }
    const filterParam =
      typeof req.query.filter === "string" ? req.query.filter : "";
    const customerParam =
      typeof req.query.customer === "string" ? req.query.customer.trim() : "";
    const reviewedOnly = filterParam === "reviewed";
    const week = await loaders.getWeek(weekStart);
    const endDate = week?.endDate ?? weekEndOf(weekStart);
    const [punches, drivers, reviewedKfiIds] = await Promise.all([
      loaders.getPunches(weekStart),
      loaders.getDrivers(),
      reviewedOnly && loaders.getReviewedKfiIds
        ? loaders.getReviewedKfiIds(weekStart)
        : Promise.resolve(null),
    ]);
    const sheets = buildTimesheets(punches, drivers, {
      reviewedKfiIds,
      customerFilter: customerParam || null,
    });
    const html = renderTimesheetsHtml({
      weekStart,
      endDate,
      sheets,
      lastRefreshedAt: week?.lastRefreshedAt ?? null,
      reviewedOnly,
      customerFilter: customerParam || null,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  };
}

export function renderTimesheetsHtml(opts: RenderTimesheetsOptions): string {
  const {
    weekStart,
    endDate,
    sheets,
    lastRefreshedAt,
    reviewedOnly = false,
    customerFilter = null,
  } = opts;
  const customerSuffix =
    customerFilter && customerFilter.trim().length > 0 ? customerFilter : "";
  const titleSuffix = reviewedOnly
    ? " (Reviewed only)"
    : customerSuffix
      ? ` (${customerSuffix})`
      : "";
  const filterMeta = reviewedOnly
    ? " &middot; <strong>reviewed only</strong>"
    : customerSuffix
      ? ` &middot; <strong>${esc(customerSuffix)}</strong> only`
      : "";
  const sheetsHtml = sheets
    .map((s, i) => {
      const checksHtml =
        s.checks.length > 0
          ? `<div class="alerts"><div class="alerts-title">Validation Alerts</div><ul>${s.checks
              .map(
                (c) =>
                  `<li><span class="alert-date">${esc(c.date || "General")}</span><span>${esc(c.message)}</span></li>`,
              )
              .join("")}</ul></div>`
          : "";
      const rowsHtml =
        s.rows.length === 0
          ? `<tr><td colspan="7" class="empty">No punches recorded for this week.</td></tr>`
          : s.rows
              .map((r) => {
                const isOt = r.otPortion > 0.0001 || r.after >= 40 - 0.0001;
                const tags: string[] = [];
                if (r.isManual) tags.push("Manual");
                if (r.edited) tags.push("Edited");
                const tagHtml = tags.length
                  ? ` <span class="tag">${tags.map(esc).join("</span> <span class=\"tag\">")}</span>`
                  : "";
                return `<tr${isOt ? ' class="ot"' : ""}>
              <td class="mono">${esc(r.date)}</td>
              <td>${esc(r.source)}${tagHtml}</td>
              <td class="mono">${esc(r.clockIn)}</td>
              <td class="mono">${esc(r.clockOut)}</td>
              <td class="num">${r.hours.toFixed(2)}</td>
              <td class="num${isOt ? " ot-num" : ""}">${r.after.toFixed(2)}</td>
              <td class="${r.source === "Driver" ? "src-driver" : "src-cust"}">${esc(r.source)}</td>
            </tr>`;
              })
              .join("");
      return `<section class="sheet${i > 0 ? " page-break" : ""}">
  <header class="sheet-head">
    <div>
      <h2>${esc(s.name)}</h2>
      <div class="sheet-meta mono">
        Customer: <strong>${esc(s.customerLabel)}</strong>
        &middot; KFI ID: <strong>${esc(s.kfiId)}</strong>
        &middot; Week of <strong>${esc(weekStart)}</strong>
      </div>
    </div>
  </header>
  <div class="stats">
    <div><span>Driver Hrs</span><strong class="src-driver">${s.totals.totalDriver.toFixed(2)}</strong></div>
    <div><span>Customer Hrs</span><strong class="src-cust">${s.totals.totalCustomer.toFixed(2)}</strong></div>
    <div><span>Total</span><strong>${s.totals.totalHours.toFixed(2)}</strong></div>
    <div><span>Regular</span><strong>${s.totals.regularHours.toFixed(2)}</strong></div>
    <div><span>Overtime</span><strong class="ot-num">${s.totals.overtimeHours.toFixed(2)}</strong></div>
  </div>
  ${checksHtml}
  <table>
    <thead><tr>
      <th>Date</th><th>Source</th><th>Clock In</th><th>Clock Out</th>
      <th class="num">Hours</th><th class="num">Running</th><th>Type</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</section>`;
    })
    .join("");

  const refreshedNote = lastRefreshedAt
    ? ` &middot; last Connecteam refresh: ${esc(new Date(lastRefreshedAt).toLocaleString())}`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>KFI Driver Timesheets — Week of ${esc(weekStart)}${esc(titleSuffix)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #0f172a; margin: 24px; }
  .actions { margin-bottom: 16px; }
  .actions button { font-size: 13px; padding: 6px 12px; border: 1px solid #cbd5e1; background: #fff; border-radius: 4px; cursor: pointer; }
  .doc-head { margin-bottom: 16px; }
  .doc-head h1 { font-size: 22px; margin: 0 0 4px; }
  .doc-head .meta { color: #475569; font-size: 13px; }
  .sheet { padding-top: 4px; }
  .page-break { page-break-before: always; }
  .sheet-head h2 { font-size: 20px; margin: 0 0 4px; }
  .sheet-meta { color: #475569; font-size: 12px; }
  .sheet-meta strong { color: #0f172a; font-weight: 600; }
  .stats { display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 14px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; margin: 12px 0; }
  .stats div { font-size: 11px; text-transform: uppercase; color: #475569; letter-spacing: 0.04em; }
  .stats strong { display: block; font-size: 18px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #0f172a; margin-top: 2px; font-weight: 700; }
  .alerts { margin: 8px 0 12px; padding: 8px 12px; border: 1px solid #f59e0b; background: #fffbeb; border-radius: 4px; }
  .alerts-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #b45309; letter-spacing: 0.04em; margin-bottom: 4px; }
  .alerts ul { margin: 0; padding: 0; list-style: none; }
  .alerts li { font-size: 12px; display: flex; gap: 8px; padding: 1px 0; color: #78350f; }
  .alert-date { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; opacity: 0.8; min-width: 90px; display: inline-block; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; }
  td.num, th.num { text-align: right; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  td.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  td.empty { text-align: center; color: #94a3b8; padding: 20px 8px; }
  .tag { display: inline-block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; padding: 0 4px; border: 1px solid #cbd5e1; border-radius: 3px; color: #475569; margin-left: 4px; }
  tr.ot { background: #fffbeb; }
  td.ot-num { color: #b45309; font-weight: 600; }
  .src-driver { color: #1d4ed8; font-weight: 600; }
  .src-cust { color: #047857; font-weight: 600; }
  @media print {
    .actions { display: none; }
    body { margin: 0.5in; }
    .sheet { page-break-inside: avoid; }
    .page-break { page-break-before: always; }
    table { break-inside: auto; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
  }
</style>
</head><body>
<div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="doc-head">
  <h1>KFI Driver Timesheets</h1>
  <div class="meta">Week of <strong>${esc(weekStart)}</strong> through <strong>${esc(endDate)}</strong> &middot; ${sheets.length} driver${sheets.length === 1 ? "" : "s"}${filterMeta}${refreshedNote}</div>
</div>
${sheetsHtml || "<p>No active drivers found for this week.</p>"}
</body></html>`;
}

/** Mirror of driver-detail.tsx formatClockCell — turns "YYYY-MM-DD H:MM AM"
 * into "MM/DD, H:MM AM" for the printable timesheet. */
function formatClockCell(value: string | null | undefined): string {
  if (!value) return "";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/);
  if (!m) return value;
  const [, , mm, dd, time] = m;
  return `${mm}/${dd}, ${time}`;
}

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
