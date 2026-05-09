import PDFDocument from "pdfkit";
import type { TimesheetSheet } from "./timesheets.js";

export interface RenderTimesheetsPdfOptions {
  weekStart: string;
  endDate: string;
  sheets: TimesheetSheet[];
  lastRefreshedAt?: Date | string | null;
  reviewedOnly?: boolean;
  overtimeOnly?: boolean;
  alertsOnly?: boolean;
  customerFilter?: string | null;
}

const PAGE_MARGIN = 36;
const SANS = "Helvetica";
const SANS_BOLD = "Helvetica-Bold";
const MONO = "Courier";
const MONO_BOLD = "Courier-Bold";

const COLOR_INK = "#0f172a";
const COLOR_MUTED = "#475569";
const COLOR_FAINT = "#94a3b8";
const COLOR_BORDER = "#cbd5e1";
const COLOR_GRID = "#e2e8f0";
const COLOR_PANEL = "#f1f5f9";
const COLOR_HEADER_BG = "#f8fafc";
const COLOR_OT_BG = "#fffbeb";
const COLOR_OT_INK = "#b45309";
const COLOR_ALERT_BORDER = "#f59e0b";
const COLOR_ALERT_INK = "#78350f";
const COLOR_DRIVER = "#1d4ed8";
const COLOR_CUSTOMER = "#047857";
const COLOR_NOTE_BG = "#eef2ff";
const COLOR_NOTE_BORDER = "#c7d2fe";
const COLOR_NOTE_INK = "#3730a3";
const COLOR_NOTE_BODY = "#312e81";

interface Column {
  label: string;
  width: number;
  align: "left" | "right";
  mono?: boolean;
}

/**
 * Render a printable timesheet PDF that mirrors the HTML view from
 * `renderTimesheetsHtml`. One driver per page so payroll always gets the same
 * page layout regardless of the dispatcher's browser.
 */
export function renderTimesheetsPdf(
  opts: RenderTimesheetsPdfOptions,
): NodeJS.ReadableStream {
  const {
    weekStart,
    endDate,
    sheets,
    lastRefreshedAt = null,
    reviewedOnly = false,
    overtimeOnly = false,
    alertsOnly = false,
    customerFilter = null,
  } = opts;

  const doc = new PDFDocument({
    size: "LETTER",
    margin: PAGE_MARGIN,
    info: {
      Title: `KFI Driver Timesheets — Week of ${weekStart}`,
      Author: "KFI Dispatch",
      Subject: `Driver timesheets for week of ${weekStart}`,
    },
  });

  const customerSuffix =
    customerFilter && customerFilter.trim().length > 0 ? customerFilter : "";
  const filterMeta = reviewedOnly
    ? " · reviewed only"
    : overtimeOnly
      ? " · overtime only"
      : alertsOnly
        ? " · with alerts only"
        : customerSuffix
          ? ` · ${customerSuffix} only`
          : "";
  const refreshedNote = lastRefreshedAt
    ? ` · last Connecteam refresh: ${formatRefreshedAt(lastRefreshedAt)}`
    : "";

  drawDocHeader(
    doc,
    weekStart,
    endDate,
    sheets.length,
    `${filterMeta}${refreshedNote}`,
  );

  if (sheets.length === 0) {
    doc.moveDown(1);
    doc.font(SANS).fontSize(11).fillColor(COLOR_MUTED);
    doc.text("No active drivers found for this week.");
    doc.end();
    return doc;
  }

  sheets.forEach((sheet, idx) => {
    if (idx > 0) doc.addPage();
    drawSheet(doc, sheet, weekStart);
  });

  doc.end();
  return doc;
}

function drawDocHeader(
  doc: PDFKit.PDFDocument,
  weekStart: string,
  endDate: string,
  driverCount: number,
  meta: string,
): void {
  doc.font(SANS_BOLD).fontSize(18).fillColor(COLOR_INK);
  doc.text("KFI Driver Timesheets");
  doc.moveDown(0.2);
  doc.font(SANS).fontSize(10).fillColor(COLOR_MUTED);
  const driverLabel = driverCount === 1 ? "driver" : "drivers";
  doc.text(
    `Week of ${weekStart} through ${endDate} · ${driverCount} ${driverLabel}${meta}`,
  );
  doc.moveDown(0.6);
}

function drawSheet(
  doc: PDFKit.PDFDocument,
  sheet: TimesheetSheet,
  weekStart: string,
): void {
  drawSheetTitle(doc, sheet);
  doc.font(MONO).fontSize(9).fillColor(COLOR_MUTED);
  doc.text(
    `Customer: ${sheet.customerLabel}   ·   KFI ID: ${sheet.kfiId}   ·   Week of ${weekStart}`,
  );
  doc.moveDown(0.5);

  if (sheet.weekNoteBodies.length > 0) {
    drawWeekNotes(doc, sheet.weekNoteBodies);
    doc.moveDown(0.4);
  }

  drawStats(doc, sheet);

  if (sheet.checks.length > 0) {
    doc.moveDown(0.4);
    drawAlerts(doc, sheet.checks);
  }

  doc.moveDown(0.4);
  drawTable(doc, sheet);
}

function drawSheetTitle(
  doc: PDFKit.PDFDocument,
  sheet: TimesheetSheet,
): void {
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.font(SANS_BOLD).fontSize(16).fillColor(COLOR_INK);
  doc.text(sheet.name, x, y, { lineBreak: false });
  if (sheet.noteCount > 0) {
    const nameWidth = doc.widthOfString(sheet.name);
    const label = `${sheet.noteCount} note${sheet.noteCount === 1 ? "" : "s"}`;
    doc.font(SANS_BOLD).fontSize(9);
    const labelWidth = doc.widthOfString(label);
    const padX = 6;
    const badgeHeight = 14;
    const badgeWidth = labelWidth + padX * 2;
    const badgeX = x + nameWidth + 8;
    const badgeY = y + 4;
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(COLOR_NOTE_BORDER)
      .fillColor(COLOR_NOTE_BG)
      .roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, badgeHeight / 2)
      .fillAndStroke()
      .restore();
    doc
      .font(SANS_BOLD)
      .fontSize(9)
      .fillColor(COLOR_NOTE_INK)
      .text(label, badgeX + padX, badgeY + 2, {
        lineBreak: false,
        width: labelWidth,
      });
    doc.fillColor(COLOR_INK);
  }
  doc.x = x;
  doc.y = y + 20;
  doc.moveDown(0.15);
}

function drawWeekNotes(
  doc: PDFKit.PDFDocument,
  bodies: ReadonlyArray<string>,
): void {
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const padding = 8;
  const titleHeight = 14;
  const innerWidth = width - padding * 2;
  const bulletColWidth = 10;
  const bodyWidth = innerWidth - bulletColWidth;

  doc.font(SANS).fontSize(9);
  let contentHeight = titleHeight;
  for (const body of bodies) {
    const h = doc.heightOfString(body, { width: bodyWidth });
    contentHeight += Math.max(12, h) + 2;
  }
  const boxHeight = contentHeight + padding * 2;
  const top = doc.y;

  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(COLOR_NOTE_BORDER)
    .fillColor(COLOR_NOTE_BG)
    .rect(x, top, width, boxHeight)
    .fillAndStroke()
    .restore();
  doc
    .font(SANS_BOLD)
    .fontSize(8)
    .fillColor(COLOR_NOTE_INK)
    .text("WEEK NOTES", x + padding, top + padding, { characterSpacing: 0.5 });

  let cy = top + padding + titleHeight;
  for (const body of bodies) {
    doc
      .font(SANS)
      .fontSize(9)
      .fillColor(COLOR_NOTE_BODY)
      .text("•", x + padding, cy, { width: bulletColWidth, lineBreak: false });
    doc
      .font(SANS)
      .fontSize(9)
      .fillColor(COLOR_NOTE_BODY)
      .text(body, x + padding + bulletColWidth, cy, { width: bodyWidth });
    const used = doc.heightOfString(body, { width: bodyWidth });
    cy += Math.max(12, used) + 2;
  }

  doc.fillColor(COLOR_INK);
  doc.y = top + boxHeight;
  doc.x = doc.page.margins.left;
}

function drawStats(doc: PDFKit.PDFDocument, sheet: TimesheetSheet): void {
  const { totals } = sheet;
  const cells: Array<{ label: string; value: string; color: string }> = [
    {
      label: "Driver Hrs",
      value: totals.totalDriver.toFixed(2),
      color: COLOR_DRIVER,
    },
    {
      label: "Customer Hrs",
      value: totals.totalCustomer.toFixed(2),
      color: COLOR_CUSTOMER,
    },
    { label: "Total", value: totals.totalHours.toFixed(2), color: COLOR_INK },
    {
      label: "Regular",
      value: totals.regularHours.toFixed(2),
      color: COLOR_INK,
    },
    {
      label: "Overtime",
      value: totals.overtimeHours.toFixed(2),
      color: COLOR_OT_INK,
    },
  ];
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;
  const height = 42;
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(COLOR_BORDER)
    .fillColor(COLOR_PANEL)
    .roundedRect(x, y, width, height, 4)
    .fillAndStroke()
    .restore();
  const cellWidth = width / cells.length;
  cells.forEach((c, i) => {
    const cx = x + i * cellWidth + 10;
    doc
      .font(SANS_BOLD)
      .fontSize(7)
      .fillColor(COLOR_MUTED)
      .text(c.label.toUpperCase(), cx, y + 7, {
        width: cellWidth - 20,
        characterSpacing: 0.5,
      });
    doc
      .font(MONO_BOLD)
      .fontSize(14)
      .fillColor(c.color)
      .text(c.value, cx, y + 19, { width: cellWidth - 20 });
  });
  doc.fillColor(COLOR_INK);
  doc.y = y + height + 4;
  doc.x = doc.page.margins.left;
}

function drawAlerts(
  doc: PDFKit.PDFDocument,
  checks: TimesheetSheet["checks"],
): void {
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const titleY = doc.y;
  const padding = 8;
  const lineHeight = 12;
  const titleHeight = 14;
  const innerWidth = width - padding * 2;
  const dateColWidth = 70;

  doc.font(SANS).fontSize(9);
  let contentHeight = titleHeight;
  for (const c of checks) {
    const msgHeight = doc.heightOfString(c.message, {
      width: innerWidth - dateColWidth - 6,
    });
    contentHeight += Math.max(lineHeight, msgHeight);
  }
  const boxHeight = contentHeight + padding * 2;

  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(COLOR_ALERT_BORDER)
    .fillColor(COLOR_OT_BG)
    .rect(x, titleY, width, boxHeight)
    .fillAndStroke()
    .restore();

  doc
    .font(SANS_BOLD)
    .fontSize(8)
    .fillColor(COLOR_OT_INK)
    .text("VALIDATION ALERTS", x + padding, titleY + padding, {
      characterSpacing: 0.5,
    });

  let cy = titleY + padding + titleHeight;
  for (const c of checks) {
    doc
      .font(MONO)
      .fontSize(8)
      .fillColor(COLOR_ALERT_INK)
      .text(c.date || "General", x + padding, cy, {
        width: dateColWidth,
        lineBreak: false,
      });
    doc
      .font(SANS)
      .fontSize(9)
      .fillColor(COLOR_ALERT_INK)
      .text(c.message, x + padding + dateColWidth + 6, cy, {
        width: innerWidth - dateColWidth - 6,
      });
    const used = doc.heightOfString(c.message, {
      width: innerWidth - dateColWidth - 6,
    });
    cy += Math.max(lineHeight, used);
  }

  doc.fillColor(COLOR_INK);
  doc.y = titleY + boxHeight + 2;
  doc.x = doc.page.margins.left;
}

function drawTable(doc: PDFKit.PDFDocument, sheet: TimesheetSheet): void {
  const x = doc.page.margins.left;
  const tableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols: Column[] = sizeColumns(tableWidth, [
    { label: "Date", weight: 1.4, align: "left", mono: true },
    { label: "Source", weight: 1.4, align: "left" },
    { label: "Clock In", weight: 1.6, align: "left", mono: true },
    { label: "Clock Out", weight: 1.6, align: "left", mono: true },
    { label: "Hours", weight: 0.9, align: "right", mono: true },
    { label: "Running", weight: 0.9, align: "right", mono: true },
    { label: "Type", weight: 1.0, align: "left" },
  ]);

  const rowPadX = 6;
  const rowPadY = 4;
  const headerHeight = 16;
  const minRowHeight = 14;

  // Header.
  let y = doc.y;
  doc
    .save()
    .fillColor(COLOR_HEADER_BG)
    .rect(x, y, tableWidth, headerHeight)
    .fill()
    .restore();
  doc.font(SANS_BOLD).fontSize(8).fillColor(COLOR_MUTED);
  let cx = x;
  for (const col of cols) {
    doc.text(col.label.toUpperCase(), cx + rowPadX, y + 4, {
      width: col.width - rowPadX * 2,
      align: col.align,
      characterSpacing: 0.5,
      lineBreak: false,
    });
    cx += col.width;
  }
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(COLOR_GRID)
    .moveTo(x, y + headerHeight)
    .lineTo(x + tableWidth, y + headerHeight)
    .stroke()
    .restore();
  y += headerHeight;

  if (sheet.rows.length === 0) {
    const h = 24;
    doc
      .font(SANS)
      .fontSize(10)
      .fillColor(COLOR_FAINT)
      .text("No punches recorded for this week.", x, y + 6, {
        width: tableWidth,
        align: "center",
        lineBreak: false,
      });
    doc.y = y + h;
    return;
  }

  for (const row of sheet.rows) {
    const isOt = row.otPortion > 0.0001 || row.after >= 40 - 0.0001;
    const tags: string[] = [];
    if (row.isManual) tags.push("Manual");
    if (row.edited) tags.push("Edited");
    const sourceText = tags.length
      ? `${row.source}  [${tags.join(" · ")}]`
      : row.source;
    const cells = [
      { text: row.date, color: COLOR_INK },
      { text: sourceText, color: COLOR_INK },
      { text: row.clockIn, color: COLOR_INK },
      { text: row.clockOut, color: COLOR_INK },
      { text: row.hours.toFixed(2), color: COLOR_INK },
      {
        text: row.after.toFixed(2),
        color: isOt ? COLOR_OT_INK : COLOR_INK,
        bold: isOt,
      },
      {
        text: row.source,
        color: row.source === "Driver" ? COLOR_DRIVER : COLOR_CUSTOMER,
        bold: true,
      },
    ];

    // Compute row height by tallest cell.
    let rowHeight = minRowHeight;
    cols.forEach((col, i) => {
      doc.font(col.mono ? MONO : SANS).fontSize(9);
      const h = doc.heightOfString(cells[i].text, {
        width: col.width - rowPadX * 2,
      });
      if (h + rowPadY * 2 > rowHeight) rowHeight = h + rowPadY * 2;
    });

    // Page break (soft) if we run off — should be rare since each driver
    // starts on a fresh page, but keeps very long rosters from clipping.
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.y;
    }

    if (isOt) {
      doc
        .save()
        .fillColor(COLOR_OT_BG)
        .rect(x, y, tableWidth, rowHeight)
        .fill()
        .restore();
    }

    cx = x;
    cols.forEach((col, i) => {
      const cell = cells[i];
      const font = cell.bold
        ? col.mono
          ? MONO_BOLD
          : SANS_BOLD
        : col.mono
          ? MONO
          : SANS;
      doc
        .font(font)
        .fontSize(9)
        .fillColor(cell.color)
        .text(cell.text, cx + rowPadX, y + rowPadY, {
          width: col.width - rowPadX * 2,
          align: col.align,
        });
      cx += col.width;
    });

    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(COLOR_GRID)
      .moveTo(x, y + rowHeight)
      .lineTo(x + tableWidth, y + rowHeight)
      .stroke()
      .restore();

    y += rowHeight;
  }
  doc.fillColor(COLOR_INK);
  doc.y = y;
}

/** Format the "last Connecteam refresh" timestamp deterministically so a
 * given week always renders the same metadata regardless of the server's
 * locale or timezone. Output looks like "2026-04-28 14:32 UTC". */
function formatRefreshedAt(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function sizeColumns(
  totalWidth: number,
  defs: Array<{
    label: string;
    weight: number;
    align: "left" | "right";
    mono?: boolean;
  }>,
): Column[] {
  const totalWeight = defs.reduce((s, d) => s + d.weight, 0);
  return defs.map((d) => ({
    label: d.label,
    align: d.align,
    mono: d.mono,
    width: (totalWidth * d.weight) / totalWeight,
  }));
}
