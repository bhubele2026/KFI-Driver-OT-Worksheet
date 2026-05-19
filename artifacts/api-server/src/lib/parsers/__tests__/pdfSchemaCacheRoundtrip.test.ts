/**
 * PDF schema-cache fast-path round-trip (Task #257).
 *
 * Pins the "second upload of an identical PDF layout skips AI" promise
 * that is the headline change for Task #257:
 *   1. Build a small PDF in memory shaped like a real customer
 *      time-detail report (Adient-style "Name (TELDxxxx)" employee
 *      headers followed by per-day data rows with "Mon DD, YYYY" date
 *      and two clock times).
 *   2. Pretend AI succeeded on the first upload by handing the AI's
 *      first ParsedPunch shape (plus rawBadge) to `inferPdfColumnRoles`
 *      — the helper that derives `employeeAnchor` and `dataRow` regex
 *      templates from the PDF text.
 *   3. Feed those inferred roles back to `readPdfWithRoles` to
 *      simulate the route's `cache` branch on the second upload.
 *   4. Assert the second-upload punches match the first-upload AI
 *      output — i.e. the deterministic reader reproduces the AI run
 *      from cached roles, no Gemini call needed.
 *
 * Also pins layout-signature stability across weeks (same template,
 * different data → same signature → cache hit), and shape validation
 * on the reader (malformed roles → null → AI re-run).
 *
 * Pure unit test: no DB, no network, no Gemini. Uses pdfkit (already a
 * runtime dep for printable timesheets) to synthesize PDFs in memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import {
  inferPdfColumnRoles,
  buildEmployeeAnchorRegex,
  buildDataRowRegex,
} from "../aiSchemaRecorder.js";
import { readPdfWithRoles } from "../genericRoleReader.js";
import {
  computeHeaderSignature,
  normalizePdfTextForSignature,
} from "../schemaSignature.js";

interface PunchLine {
  date: string; // human "May 12, 2026"
  timeIn: string; // "6:00 AM"
  timeOut: string; // "2:30 PM"
  hours: string; // "8.50"
}

interface EmployeeBlock {
  name: string;
  badge: string;
  punches: PunchLine[];
}

/**
 * Synthesize an Adient-style time-detail PDF in memory. Layout is
 * intentionally close to the real Adient export so the regex
 * inference exercises realistic anchor / data-row contexts:
 *
 *   Adient Time Detail Report
 *   Period: ...
 *   BAILEY, R. (TELD9001)
 *   May 12, 2026   6:00 AM   2:30 PM   8.50
 *   May 13, 2026   6:00 AM   4:00 PM   10.00
 *   JONES, K. (TELD9002)
 *   May 12, 2026   7:15 AM   3:45 PM   8.50
 */
function buildAdientLikePdf(blocks: EmployeeBlock[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Courier");
    doc.fontSize(11);
    doc.text("Adient Time Detail Report");
    doc.text("Period: 05/10/2026 - 05/16/2026");
    doc.moveDown(0.5);
    for (const b of blocks) {
      doc.text(`${b.name} (${b.badge})`);
      for (const p of b.punches) {
        doc.text(`${p.date}   ${p.timeIn}   ${p.timeOut}   ${p.hours}`);
      }
      doc.moveDown(0.25);
    }
    doc.end();
  });
}

test("PDF schema cache round-trip: AI roles inferred from PDF reproduce punches via readPdfWithRoles", async () => {
  const buffer = await buildAdientLikePdf([
    {
      name: "BAILEY, R.",
      badge: "TELD9001",
      punches: [
        { date: "May 12, 2026", timeIn: "6:00 AM", timeOut: "2:30 PM", hours: "8.50" },
        { date: "May 13, 2026", timeIn: "6:00 AM", timeOut: "4:00 PM", hours: "10.00" },
      ],
    },
    {
      name: "JONES, K.",
      badge: "TELD9002",
      punches: [
        { date: "May 12, 2026", timeIn: "7:15 AM", timeOut: "3:45 PM", hours: "8.50" },
      ],
    },
  ]);

  // Simulate the first AI-extracted punch, mirroring what
  // imageSupport.toParsedPunch would emit (kfiId post-mapping, rawBadge
  // carried through unchanged).
  const aiFirst = {
    rawBadge: "TELD9001",
    clockIn: "2026-05-12 6:00 AM",
    clockOut: "2026-05-12 2:30 PM",
    hours: 8.5,
  };
  const roles = await inferPdfColumnRoles(buffer, aiFirst, 2026);
  assert.ok(roles, "inferPdfColumnRoles should derive employee + data templates");
  assert.equal(roles.format, "pdf");
  // Sanity-check the anchor regex picks up the badge inside parens.
  const empRe = new RegExp(roles.employeeAnchor.regex);
  const m = empRe.exec("OTHER, P. (TELD7777)");
  assert.ok(m, "employee anchor should match other employees in the same layout");
  assert.equal(m![1], "TELD7777", "anchor captures the badge in group 1");

  // Simulate the second upload: route calls lookupSchema → "cache" →
  // readPdfWithRoles. Map both badges 1:1 to themselves for the test.
  const idMap: Record<string, string> = {
    TELD9001: "TELD9001",
    TELD9002: "TELD9002",
  };
  const kfiSet = new Set(Object.values(idMap));
  const parsed = await readPdfWithRoles(
    "Adient",
    buffer,
    roles,
    kfiSet,
    idMap,
    "2026-05-10",
    "2026-05-16",
  );
  assert.ok(parsed, "readPdfWithRoles should return a ParseResult");
  assert.equal(parsed.punches.length, 3, "all 3 in-window punches included");
  assert.equal(parsed.unmappedIds.length, 0, "no unmapped ids");
  const first = parsed.punches[0];
  assert.equal(first.kfiId, "TELD9001");
  assert.equal(first.date, "2026-05-12");
  assert.equal(first.clockIn, "2026-05-12 6:00 AM");
  assert.equal(first.clockOut, "2026-05-12 2:30 PM");
  assert.equal(first.hours, 8.5);
  // Second employee's punch lands under the right kfiId — proves the
  // employee anchor actually switches the current driver.
  const jones = parsed.punches.find((p) => p.kfiId === "TELD9002");
  assert.ok(jones, "punch attributed to TELD9002 via employee anchor switch");
  assert.equal(jones!.clockIn, "2026-05-12 7:15 AM");
});

test("PDF signature stays stable across weeks for the same template", async () => {
  const weekA = await buildAdientLikePdf([
    {
      name: "BAILEY, R.",
      badge: "TELD9001",
      punches: [
        { date: "May 12, 2026", timeIn: "6:00 AM", timeOut: "2:30 PM", hours: "8.50" },
      ],
    },
  ]);
  const weekB = await buildAdientLikePdf([
    {
      name: "OTHER, P.",
      badge: "TELD7777",
      punches: [
        { date: "May 19, 2026", timeIn: "7:00 AM", timeOut: "3:30 PM", hours: "8.50" },
      ],
    },
  ]);
  const sigA = await computeHeaderSignature("adient-w1.pdf", weekA);
  const sigB = await computeHeaderSignature("adient-w2.pdf", weekB);
  assert.ok(sigA, "week 1 signature computed");
  assert.ok(sigB, "week 2 signature computed");
  assert.equal(
    sigA,
    sigB,
    "different weeks of the same Adient template hash identically",
  );
});

test("normalizePdfTextForSignature strips per-week variability", () => {
  const a = normalizePdfTextForSignature(
    "Adient Time Detail Report Period: 05/10/2026 - 05/16/2026 BAILEY, R. (TELD9001) May 12, 2026 6:00 AM 2:30 PM 8.50",
  );
  const b = normalizePdfTextForSignature(
    "Adient Time Detail Report Period: 05/17/2026 - 05/23/2026 OTHER, P. (TELD7777) May 19, 2026 7:00 AM 3:30 PM 8.50",
  );
  assert.equal(a, b, "names, badges, dates, times, hours all normalized away");
});

test("readPdfWithRoles bails when columnRoles is malformed (forces AI re-run)", async () => {
  const buffer = await buildAdientLikePdf([
    {
      name: "BAILEY, R.",
      badge: "TELD9001",
      punches: [
        { date: "May 12, 2026", timeIn: "6:00 AM", timeOut: "2:30 PM", hours: "8.50" },
      ],
    },
  ]);
  const parsed = await readPdfWithRoles(
    "Adient",
    buffer,
    { format: "xlsx", badge: 1 } as unknown,
    new Set(),
    {},
    "2026-05-10",
    "2026-05-16",
  );
  assert.equal(parsed, null);
});

test("buildEmployeeAnchorRegex captures the badge surrounded by literal context", () => {
  const re = buildEmployeeAnchorRegex(
    ["BAILEY, R. (TELD9001)", "May 12, 2026 6:00 AM"],
    "TELD9001",
  );
  assert.ok(re);
  const r = new RegExp(re!);
  const m1 = r.exec("OTHER, P. (TELD7777)");
  assert.ok(m1, "matches a different employee in the same layout");
  assert.equal(m1![1], "TELD7777");
  // Should NOT match an unrelated bare token (no parens around it).
  assert.equal(r.exec("Total hours TELD9999 reported"), null);
});

test("buildDataRowRegex captures both times and tolerates other punches with different values", () => {
  const re = buildDataRowRegex(
    ["May 12, 2026   6:00 AM   2:30 PM   8.50"],
    "2026-05-12 6:00 AM",
    "2026-05-12 2:30 PM",
    8.5,
  );
  assert.ok(re);
  const r = new RegExp(re!);
  const m = r.exec("May 19, 2026   7:15 AM   4:45 PM   9.50");
  assert.ok(m, "matches a different day's punch in the same layout");
  assert.equal(m![1].trim(), "7:15 AM");
  assert.equal(m![2].trim(), "4:45 PM");
});
