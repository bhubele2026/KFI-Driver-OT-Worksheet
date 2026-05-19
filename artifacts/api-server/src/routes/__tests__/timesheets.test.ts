import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Driver, Punch } from "@workspace/db/schema";
import { makeTimesheetsHandler } from "../../lib/timesheets.js";
import { computeDriverTotals } from "../../lib/hoursEngine.js";

const WEEK_START = "2026-04-27";
const WEEK_END = "2026-05-03";

let nextId = 1;
function p(over: Partial<Punch> & { kfiId: string; date: string }): Punch {
  return {
    id: nextId++,
    weekStart: WEEK_START,
    customer: null,
    source: "Driver",
    clockIn: `${over.date} 8:00 AM`,
    clockOut: `${over.date} 4:00 PM`,
    hours: "8.000",
    payType: null,
    dispTz: "America/Chicago",
    isManual: false,
    edited: false,
    ctExternalKey: null,
    fileOrigin: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-04-28T12:00:00Z"),
    updatedAt: new Date("2026-04-28T12:00:00Z"),
    ...over,
  } as Punch;
}

function shift(
  kfiId: string,
  date: string,
  startHour: number,
  hours: number,
  source: "Driver" | "Customer" = "Driver",
  customer: string | null = null,
): Punch {
  const sh = (h: number): string => {
    const hr12 = ((h + 11) % 12) + 1;
    const ampm = h < 12 || h === 24 ? "AM" : "PM";
    return `${date} ${hr12}:00 ${ampm}`;
  };
  return p({
    kfiId,
    date,
    clockIn: sh(startHour),
    clockOut: sh(startHour + hours),
    hours: hours.toFixed(3),
    source,
    customer,
  });
}

function driver(kfiId: string, name: string, customer: string): Driver {
  return {
    kfiId,
    name,
    customer,
    ctUserId: null,
    isDriver: true,
    isArchived: false,
    displayTz: null,
    displayTzUpdatedBy: null,
    displayTzUpdatedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

interface Fixture {
  drivers: Driver[];
  punches: Punch[];
}

function buildFixture(): Fixture {
  const drivers: Driver[] = [
    driver("D-ADIENT-1", "Alice Adient", "Adient"),
    driver("D-ADIENT-2", "Sam Splitter", "Adient"),
    driver("D-GREYSTONE", "Greg Greystone", "Greystone"),
    driver("D-ROSTER-FIX", "Owen Orphan", "Unknown"),
  ];
  const punches: Punch[] = [
    // Alice — single 8h shift.
    shift("D-ADIENT-1", "2026-04-27", 8, 8),
    // Sam — 4 x 9h then a 9h shift that crosses the 40h threshold (4 RT + 5 OT).
    shift("D-ADIENT-2", "2026-04-27", 8, 9),
    shift("D-ADIENT-2", "2026-04-28", 8, 9),
    shift("D-ADIENT-2", "2026-04-29", 8, 9),
    shift("D-ADIENT-2", "2026-04-30", 8, 9),
    shift("D-ADIENT-2", "2026-05-01", 8, 9),
    // Greg Greystone — 8h shift.
    shift("D-GREYSTONE", "2026-04-27", 8, 8),
    // Owen — punch with junk customer name → roster-cleanup bucket.
    shift("D-ROSTER-FIX", "2026-04-27", 8, 8, "Driver", "Unknown"),
  ];
  return { drivers, punches };
}

async function startServer(
  fixture: Fixture,
  options: {
    reviewedKfiIds?: ReadonlySet<string>;
    noteSummaries?: ReadonlyMap<string, { count: number }>;
  } = {},
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.get(
    "/weeks/:weekStart/timesheets",
    makeTimesheetsHandler({
      getWeek: async (ws) =>
        ws === WEEK_START
          ? { endDate: WEEK_END, lastRefreshedAt: null }
          : null,
      getPunches: async (ws) =>
        ws === WEEK_START ? fixture.punches : [],
      getDrivers: async () => fixture.drivers,
      getReviewedKfiIds: options.reviewedKfiIds
        ? async () => options.reviewedKfiIds!
        : undefined,
      getNoteSummaries: options.noteSummaries
        ? async () => options.noteSummaries!
        : undefined,
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("GET /weeks/:weekStart/timesheets returns 200 HTML with correct order, totals, OT highlighting, and page breaks", async () => {
  const fixture = buildFixture();
  const { url, close } = await startServer(fixture);
  try {
    const res = await fetch(`${url}/weeks/${WEEK_START}/timesheets`);
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-type") ?? "",
      /^text\/html(;|$)/,
      "Content-Type is text/html",
    );
    const html = await res.text();

    // Driver order matches the dashboard sidebar:
    //   Adient (KNOWN_CUSTOMERS[0]) → Greystone → Needs roster cleanup.
    // Within Adient, drivers sort by name: Alice Adient before Sam Splitter.
    const headlineOrder = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(headlineOrder, [
      "Alice Adient",
      "Sam Splitter",
      "Greg Greystone",
      "Owen Orphan",
    ]);

    // Each non-first <section> carries the `page-break` marker so payroll's
    // print-to-PDF puts each driver on its own page.
    const sectionCount = (html.match(/<section class="sheet/g) ?? []).length;
    const pageBreakCount = (
      html.match(/<section class="sheet page-break"/g) ?? []
    ).length;
    assert.equal(sectionCount, 4);
    assert.equal(
      pageBreakCount,
      3,
      "every non-first driver section gets a page-break",
    );

    // Per-driver totals match computeDriverTotals(...) — the Sam Splitter
    // section shows 45.00 total / 40.00 RT / 5.00 OT.
    const samPunches = fixture.punches.filter(
      (x) => x.kfiId === "D-ADIENT-2",
    );
    const expected = computeDriverTotals(samPunches);
    assert.equal(expected.totalHours, 45);
    assert.equal(expected.regularHours, 40);
    assert.equal(expected.overtimeHours, 5);
    const samSection = html.split('<h2>Sam Splitter</h2>')[1].split(
      "</section>",
    )[0];
    assert.match(samSection, />45\.00</);
    assert.match(samSection, />40\.00</);
    assert.match(samSection, />5\.00</);

    // OT row highlight: Sam's boundary-crossing shift renders as <tr class="ot">
    // with the running cell using `class="num ot-num"`.
    assert.match(samSection, /<tr class="ot">/);
    assert.match(samSection, /class="num ot-num"/);

    // Roster-cleanup driver carries the labelled bucket and sorts last.
    const owenSection = html.split('<h2>Owen Orphan</h2>')[1].split(
      "</section>",
    )[0];
    assert.match(
      owenSection,
      /Customer:\s*<strong>Needs roster cleanup<\/strong>/,
    );
  } finally {
    await close();
  }
});

test("GET /weeks/:weekStart/timesheets?format=pdf streams an application/pdf attachment", async () => {
  const fixture = buildFixture();
  const { url, close } = await startServer(fixture);
  try {
    const res = await fetch(
      `${url}/weeks/${WEEK_START}/timesheets?format=pdf`,
    );
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-type") ?? "",
      /^application\/pdf/,
      "Content-Type is application/pdf",
    );
    const cd = res.headers.get("content-disposition") ?? "";
    assert.match(cd, /attachment/);
    assert.match(cd, /kfi-timesheets-2026-04-27\.pdf/);
    const buf = Buffer.from(await res.arrayBuffer());
    // Real PDFs start with the "%PDF-" magic header and end with "%%EOF".
    assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.match(buf.subarray(-10).toString("ascii"), /%%EOF\s*$/);
    // 4 drivers => one /Page object per driver in the page tree.
    const pageCount = (buf.toString("binary").match(/\/Type\s*\/Page[^s]/g) ?? [])
      .length;
    assert.equal(pageCount, 4, "one page per driver section");
  } finally {
    await close();
  }
});

test("GET /weeks/:weekStart/timesheets?format=pdf&filter=reviewed names the file with a 'reviewed' suffix", async () => {
  const fixture = buildFixture();
  const { url, close } = await startServer(fixture, {
    reviewedKfiIds: new Set(["D-ADIENT-1"]),
  });
  try {
    const res = await fetch(
      `${url}/weeks/${WEEK_START}/timesheets?format=pdf&filter=reviewed`,
    );
    assert.equal(res.status, 200);
    const cd = res.headers.get("content-disposition") ?? "";
    assert.match(cd, /kfi-timesheets-2026-04-27-reviewed\.pdf/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-");
  } finally {
    await close();
  }
});

test("GET /weeks/:weekStart/timesheets renders the per-driver note-count badge in HTML and PDF", async () => {
  const fixture = buildFixture();
  const noteSummaries = new Map<string, { count: number }>([
    ["D-ADIENT-1", { count: 2 }],
    ["D-ADIENT-2", { count: 1 }],
  ]);
  const { url, close } = await startServer(fixture, { noteSummaries });
  try {
    const htmlRes = await fetch(`${url}/weeks/${WEEK_START}/timesheets`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    const aliceSection = html
      .split("<h2>Alice Adient")[1]
      .split("</section>")[0];
    assert.match(aliceSection, /<span class="note-badge">2 notes<\/span>/);
    // The legacy "Week notes" callout has been removed.
    assert.doesNotMatch(aliceSection, /class="week-notes"/);
    const samSection = html
      .split("<h2>Sam Splitter")[1]
      .split("</section>")[0];
    assert.match(samSection, /<span class="note-badge">1 note<\/span>/);
    assert.doesNotMatch(samSection, /class="week-notes"/);
    const owenSection = html
      .split("<h2>Owen Orphan</h2>")[1]
      .split("</section>")[0];
    assert.doesNotMatch(owenSection, /class="note-badge"/);

    // PDF still streams as a real PDF when notes are present (pdfkit
    // compresses streams so we can't grep the text content here — the HTML
    // assertions above plus the unit tests in lib/__tests__/timesheets.test.ts
    // cover the rendered "N notes" badge).
    const pdfRes = await fetch(
      `${url}/weeks/${WEEK_START}/timesheets?format=pdf`,
    );
    assert.equal(pdfRes.status, 200);
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdfBuf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.match(pdfBuf.subarray(-10).toString("ascii"), /%%EOF\s*$/);
  } finally {
    await close();
  }
});

test("GET /weeks/:weekStart/timesheets renders the seven-row Summary, reconciling Checks panel, and chronological Driver+Customer rows", async () => {
  // Mixed Driver+Customer week that crosses the 40h boundary mid-shift.
  // Monday   35.39h Customer  →  running 35.39
  // Thursday  6.54h Driver    →  running 41.93  (4.61 RT + 1.93 OT)
  // Friday   12.68h Customer  →  running 54.61  (entirely OT)
  // → Total Driver 6.54, Total Customer 48.07, RT 40.00, OT 14.61,
  //   Driver RT 4.61, Driver OT 1.93.
  const drivers: Driver[] = [
    driver("D-MIX", "Mixed Source Driver", "Adient"),
  ];
  const punches: Punch[] = [
    p({
      kfiId: "D-MIX",
      date: "2026-04-27",
      clockIn: "2026-04-27 8:00 AM",
      clockOut: "2026-04-28 7:23 PM",
      hours: "35.390",
      source: "Customer",
      customer: "Adient",
    }),
    p({
      kfiId: "D-MIX",
      date: "2026-04-30",
      clockIn: "2026-04-30 9:00 AM",
      clockOut: "2026-04-30 3:32 PM",
      hours: "6.540",
      source: "Driver",
    }),
    p({
      kfiId: "D-MIX",
      date: "2026-05-01",
      clockIn: "2026-05-01 10:00 AM",
      clockOut: "2026-05-01 10:41 PM",
      hours: "12.680",
      source: "Customer",
      customer: "Adient",
    }),
  ];
  const { url, close } = await startServer({ drivers, punches });
  try {
    const res = await fetch(`${url}/weeks/${WEEK_START}/timesheets`);
    assert.equal(res.status, 200);
    const html = await res.text();
    const section = html.split('<h2>Mixed Source Driver</h2>')[1]
      .split("</section>")[0];

    // Summary card with seven rows.
    assert.match(section, /data-testid="card-summary"/);
    assert.match(section, /<th>Total Driver<\/th><td class="num">6\.54</);
    assert.match(section, /<th>Total Customer<\/th><td class="num">48\.07</);
    assert.match(section, /<th>Total Hours<\/th><td class="num">54\.61</);
    assert.match(section, /<th>RT<\/th><td class="num">40\.00</);
    assert.match(section, /<th>OT<\/th><td class="num ot-num">14\.61</);
    assert.match(section, /<th>Driver RT<\/th><td class="num">4\.61</);
    assert.match(section, /<th>Driver OT<\/th><td class="num ot-num">1\.93</);

    // Checks card in the "all reconcile" state.
    assert.match(section, /data-testid="card-checks"/);
    assert.match(section, /sum-checks ok/);
    assert.match(section, /Checks — all reconcile/);
    // All six reconciliation labels present.
    for (const label of [
      "Total = Driver \\+ Customer",
      "Customer = Total − Driver",
      "Driver = Total − Customer",
      "RT = min\\(Total, 40\\)",
      "OT = max\\(0, Total − 40\\)",
      "RT \\+ OT = Total",
    ]) {
      assert.match(section, new RegExp(label));
    }
    // No mismatch markers should be present in the green-path render.
    assert.doesNotMatch(section, /check-warn/);

    // Punch rows render in a single chronological sequence interleaving
    // Driver and Customer (Customer 2026-04-27 → Driver 2026-04-30 →
    // Customer 2026-05-01) rather than grouping by source.
    const tbody = section.split("<tbody>")[1].split("</tbody>")[0];
    const dateOrder = [...tbody.matchAll(/<td class="mono">(\d{4}-\d{2}-\d{2})<\/td>/g)]
      .map((m) => m[1]);
    assert.deepEqual(dateOrder, [
      "2026-04-27",
      "2026-04-30",
      "2026-05-01",
    ]);
    // And the source column (column 2) interleaves Customer/Driver/Customer.
    const sourceOrder = [...tbody.matchAll(/<tr(?:\s[^>]*)?>\s*<td class="mono">\d{4}-\d{2}-\d{2}<\/td>\s*<td>([^<]+)/g)]
      .map((m) => m[1].trim());
    assert.deepEqual(sourceOrder, ["Customer", "Driver", "Customer"]);
  } finally {
    await close();
  }
});

test("GET /weeks/:weekStart/timesheets?format=pdf renders a mixed-source driver-week with no errors (Summary + Checks block included)", async () => {
  // Drives the same seven-row Summary + six-row Checks paths in the PDF
  // renderer (drawSummaryAndChecks) as the HTML test above. pdfkit's
  // content streams are Flate-encoded so grepping the binary for label
  // strings isn't reliable; instead we assert the renderer produces a
  // valid single-page PDF without throwing on the mixed-source totals
  // (totalDriver / totalCustomer / driverRt / driverOt all non-zero).
  const drivers: Driver[] = [
    driver("D-MIX-PDF", "Mixed Source Driver", "Adient"),
  ];
  const punches: Punch[] = [
    p({
      kfiId: "D-MIX-PDF",
      date: "2026-04-27",
      clockIn: "2026-04-27 8:00 AM",
      clockOut: "2026-04-28 7:23 PM",
      hours: "35.390",
      source: "Customer",
      customer: "Adient",
    }),
    p({
      kfiId: "D-MIX-PDF",
      date: "2026-04-30",
      clockIn: "2026-04-30 9:00 AM",
      clockOut: "2026-04-30 3:32 PM",
      hours: "6.540",
      source: "Driver",
    }),
    p({
      kfiId: "D-MIX-PDF",
      date: "2026-05-01",
      clockIn: "2026-05-01 10:00 AM",
      clockOut: "2026-05-01 10:41 PM",
      hours: "12.680",
      source: "Customer",
      customer: "Adient",
    }),
  ];
  const { url, close } = await startServer({ drivers, punches });
  try {
    const res = await fetch(
      `${url}/weeks/${WEEK_START}/timesheets?format=pdf`,
    );
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.match(buf.subarray(-10).toString("ascii"), /%%EOF\s*$/);
    const pageCount = (buf.toString("binary").match(/\/Type\s*\/Page[^s]/g) ?? [])
      .length;
    assert.equal(pageCount, 1, "single driver → single page");
  } finally {
    await close();
  }
});

test("GET /weeks/:weekStart/timesheets rejects malformed week strings with 400", async () => {
  const { url, close } = await startServer({ drivers: [], punches: [] });
  try {
    const res = await fetch(`${url}/weeks/not-a-week/timesheets`);
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
