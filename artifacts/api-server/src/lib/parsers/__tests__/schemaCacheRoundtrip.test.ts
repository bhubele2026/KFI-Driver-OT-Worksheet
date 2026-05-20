/**
 * Schema-cache fast-path round-trip (Task #250).
 *
 * Pins the "second upload of an identical layout skips AI" promise that
 * is the headline change for Task #250:
 *   1. Build a small xlsx in memory shaped like a real customer export.
 *   2. Pretend AI succeeded on the first upload by handing the
 *      `aiResult.punches[0]` shape to `inferColumnRoles` — the helper
 *      that decides which xlsx columns held badge / date / timeIn /
 *      timeOut.
 *   3. Feed those inferred roles back to `readWithRoles` to simulate
 *      the route's `cache` branch on the second upload.
 *   4. Assert the second-upload punches match the first-upload AI
 *      output — i.e. the deterministic reader reproduces the AI run
 *      from cached roles, no Gemini call needed.
 *
 * This is what makes "upload identical Trienda layout next week" go
 * from a 30-90s AI round-trip to a sub-100ms deterministic parse.
 *
 * Pure unit test: no DB, no network, no Gemini.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { inferColumnRoles } from "../aiSchemaRecorder.js";
import { readWithRoles } from "../genericRoleReader.js";

function buildTriendaLikeXlsx(): Buffer {
  // Mirrors the columns a Kronos-style pivot export carries: a noise
  // column up front (employee name), then badge, date, in, out, hours.
  const rows = [
    ["Employee Name", "Badge", "Date", "Time In", "Time Out", "Hours"],
    ["BAILEY, R.", "TELD9001", "2026-05-12", "6:00 AM", "2:30 PM", 8.5],
    ["BAILEY, R.", "TELD9001", "2026-05-13", "6:00 AM", "4:00 PM", 10],
    ["JONES, K.", "TELD9002", "2026-05-12", "7:15 AM", "3:45 PM", 8.5],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

test("schema cache round-trip: AI roles inferred from xlsx reproduce punches via readWithRoles", () => {
  const buffer = buildTriendaLikeXlsx();

  // Simulate the first AI-extracted punch. The recorder uses kfiId
  // (post-mapping) as the raw-badge search needle, so we pass the
  // xlsx's actual badge string for the round-trip.
  const aiFirst = {
    rawBadge: "TELD9001",
    dateIso: "2026-05-12",
    clockIn: "2026-05-12 6:00 AM",
    clockOut: "2026-05-12 2:30 PM",
  };
  const roles = inferColumnRoles(buffer, aiFirst);
  assert.ok(roles, "inferColumnRoles should locate the AI row in the xlsx");
  // Columns: 0=Name, 1=Badge, 2=Date, 3=In, 4=Out, 5=Hours.
  assert.equal(roles.badge, 1, "badge column index");
  assert.equal(roles.date, 2, "date column index");
  assert.equal(roles.timeIn, 3, "timeIn column index");
  assert.equal(roles.timeOut, 4, "timeOut column index");

  // Simulate the second upload: route would call lookupSchema → "cache"
  // → readWithRoles. Map both badges 1:1 to themselves for the test.
  const idMap: Record<string, string> = {
    TELD9001: "TELD9001",
    TELD9002: "TELD9002",
  };
  const kfiSet = new Set(Object.values(idMap));
  const parsed = readWithRoles(
    "Trienda",
    buffer,
    roles,
    kfiSet,
    idMap,
    "2026-05-10", // Sunday
    "2026-05-16", // Saturday
  );
  assert.ok(parsed, "readWithRoles should return a ParseResult");
  assert.equal(parsed.punches.length, 3, "all 3 in-window punches included");
  assert.equal(parsed.unmappedIds.length, 0, "no unmapped ids");
  const first = parsed.punches[0];
  assert.equal(first.kfiId, "TELD9001");
  assert.equal(first.date, "2026-05-12");
  assert.equal(first.clockIn, "2026-05-12 6:00 AM");
  assert.equal(first.clockOut, "2026-05-12 2:30 PM");
  // Sanity-check hours from explicit column.
  assert.equal(first.hours, 8.5);
});

test("readWithRoles bails when columnRoles is malformed (forces AI re-run)", () => {
  const buffer = buildTriendaLikeXlsx();
  const parsed = readWithRoles(
    "Trienda",
    buffer,
    { badge: "B" } as unknown, // wrong shape
    new Set(),
    {},
    "2026-05-10",
    "2026-05-16",
  );
  assert.equal(parsed, null);
});

test("readWithRoles drops out-of-window rows", () => {
  const buffer = buildTriendaLikeXlsx();
  const roles = { badge: 1, date: 2, timeIn: 3, timeOut: 4, hours: 5 };
  const idMap = { TELD9001: "TELD9001", TELD9002: "TELD9002" };
  const parsed = readWithRoles(
    "Trienda",
    buffer,
    roles,
    new Set(Object.values(idMap)),
    idMap,
    "2026-05-17", // next week — all rows out of window
    "2026-05-23",
  );
  assert.ok(parsed);
  assert.equal(parsed.punches.length, 0);
});

test("readWithRoles tracks unmapped badges instead of dropping silently", () => {
  const buffer = buildTriendaLikeXlsx();
  const roles = { badge: 1, date: 2, timeIn: 3, timeOut: 4, hours: 5 };
  const parsed = readWithRoles(
    "Trienda",
    buffer,
    roles,
    new Set(["TELD9001"]),
    { TELD9001: "TELD9001" },
    "2026-05-10",
    "2026-05-16",
  );
  assert.ok(parsed);
  // TELD9001 maps (2 punches), TELD9002 doesn't (1 row → unmapped).
  assert.equal(parsed.punches.length, 2);
  assert.equal(parsed.unmappedIds.length, 1);
  assert.equal(parsed.unmappedIds[0].id, "TELD9002");
  assert.equal(parsed.unmappedIds[0].count, 1);
});

/*
 * Task #338: when the AI run that recorded the recipe could see a
 * driver-name column, the cached fast-path reader must surface that
 * name in `unmappedIds[].sampleName` so the dispatcher's unmapped
 * panel doesn't fall back to "(no name on doc)" on re-uploads.
 */
test("schema cache round-trip: name column is inferred and carried through to unmapped rows", () => {
  const buffer = buildTriendaLikeXlsx();
  const aiFirst = {
    rawBadge: "TELD9002",
    dateIso: "2026-05-12",
    clockIn: "2026-05-12 7:15 AM",
    clockOut: "2026-05-12 3:45 PM",
    name: "JONES, K.",
  };
  const roles = inferColumnRoles(buffer, aiFirst);
  assert.ok(roles, "inferColumnRoles should locate the AI row in the xlsx");
  assert.equal(roles.name, 0, "name column index (column 0 = Employee Name)");

  // Roster only includes TELD9001 → TELD9002 should appear unmapped
  // with its name from column 0 carried through.
  const parsed = readWithRoles(
    "Trienda",
    buffer,
    roles,
    new Set(["TELD9001"]),
    { TELD9001: "TELD9001" },
    "2026-05-10",
    "2026-05-16",
  );
  assert.ok(parsed);
  assert.equal(parsed.unmappedIds.length, 1);
  assert.equal(parsed.unmappedIds[0].id, "TELD9002");
  assert.equal(parsed.unmappedIds[0].sampleName, "JONES, K.");
});

/*
 * Task #338: cached recipes written before the name column was
 * tracked must keep working — the reader treats `name` as optional
 * and falls back to a null sampleName instead of throwing.
 */
test("readWithRoles tolerates legacy recipes with no name column", () => {
  const buffer = buildTriendaLikeXlsx();
  // Legacy shape: no `name` field at all.
  const roles = { badge: 1, date: 2, timeIn: 3, timeOut: 4, hours: 5 };
  const parsed = readWithRoles(
    "Trienda",
    buffer,
    roles,
    new Set(["TELD9001"]),
    { TELD9001: "TELD9001" },
    "2026-05-10",
    "2026-05-16",
  );
  assert.ok(parsed);
  assert.equal(parsed.unmappedIds.length, 1);
  assert.equal(parsed.unmappedIds[0].id, "TELD9002");
  assert.equal(parsed.unmappedIds[0].sampleName, null);
});
