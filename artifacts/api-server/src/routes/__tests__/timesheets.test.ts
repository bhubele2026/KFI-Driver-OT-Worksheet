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

async function startServer(fixture: Fixture): Promise<{
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

test("GET /weeks/:weekStart/timesheets rejects malformed week strings with 400", async () => {
  const { url, close } = await startServer({ drivers: [], punches: [] });
  try {
    const res = await fetch(`${url}/weeks/not-a-week/timesheets`);
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
