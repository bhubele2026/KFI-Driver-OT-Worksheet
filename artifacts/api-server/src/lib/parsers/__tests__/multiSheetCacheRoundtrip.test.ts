/**
 * A1 — multi-sheet cache round-trip (Phase-2 `sheetSelector`).
 *
 * Regression guard for the Orgill case: the customer workbook ships TWO
 * sheets — a "Master External" Zenople export as sheet 1 and the real
 * daily timecard as another sheet. Before A1, the signature, the layout
 * recorder, and the deterministic reader all hardcoded `SheetNames[0]`,
 * so a cached re-upload would read the WRONG sheet (Master export) and
 * either mis-parse or never cache. These tests pin that the customer's
 * `sheetSelector` rule drives sheet selection consistently across
 * resolve → sign → infer → read.
 *
 * Pure unit test: no DB, no network, no Gemini.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  computeHeaderSignature,
  resolveSheetName,
} from "../schemaSignature.js";
import { inferColumnRoles } from "../aiSchemaRecorder.js";
import { readWithRoles } from "../genericRoleReader.js";

// Prose selector like the one seeded for Orgill — deliberately NOT a tab
// name, so resolution must fall through to header-token overlap.
const ORGILL_SELECTOR =
  "the daily timesheet sheet (Employee ID / Apply date / Start time / End time / Total columns) — NOT the Master External export sheet";

/**
 * Two-sheet workbook: sheet 1 is the Zenople "Master External" export
 * (different shape, wrong data for punch reading); sheet 2 is the real
 * timecard whose Total column already nets the break (5:59a–6:30p = 12,
 * not the 12.53 raw span).
 */
function buildOrgillLikeXlsx(): Buffer {
  const master = XLSX.utils.aoa_to_sheet([
    ["Customer", "Person", "PersonId", "TransactionCode", "Pay Unit"],
    ["Orgill, Inc.", "CHISLEY, MARICE N", "2005658", "RT", 40],
    ["Orgill, Inc.", "CHISLEY, MARICE N", "2005658", "OT", 20],
  ]);
  const timecard = XLSX.utils.aoa_to_sheet([
    ["Employee ID", "Employee Full Name", "Apply date", "Start time", "End time", "Total"],
    ["90098522", "Chisley, Marice N", "2026-07-06", "5:59 AM", "6:30 PM", 12],
    ["90098522", "Chisley, Marice N", "2026-07-07", "5:59 AM", "6:30 PM", 12],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, master, "Master External");
  XLSX.utils.book_append_sheet(wb, timecard, "Timecard");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

test("resolveSheetName: exact / substring / index / token-overlap / fallback", () => {
  const wb = XLSX.read(buildOrgillLikeXlsx(), { type: "buffer" });
  // no selector → first sheet (historical default)
  assert.equal(resolveSheetName(wb, undefined), "Master External");
  // exact (case-insensitive)
  assert.equal(resolveSheetName(wb, "timecard"), "Timecard");
  // numeric 1-based index
  assert.equal(resolveSheetName(wb, "2"), "Timecard");
  // prose selector → header-token overlap picks the timecard sheet
  assert.equal(resolveSheetName(wb, ORGILL_SELECTOR), "Timecard");
  // unmatched selector → fallback to first sheet
  assert.equal(resolveSheetName(wb, "nonexistent zzz"), "Master External");
});

test("signature is computed on the SELECTED sheet, not always sheet 1", async () => {
  const buffer = buildOrgillLikeXlsx();
  const sigDefault = await computeHeaderSignature("orgill.xlsx", buffer);
  const sigSelected = await computeHeaderSignature(
    "orgill.xlsx",
    buffer,
    ORGILL_SELECTOR,
  );
  assert.ok(sigDefault && sigSelected);
  assert.notEqual(
    sigDefault,
    sigSelected,
    "selecting the timecard sheet must change the signature vs the Master sheet",
  );
  // Selecting by exact tab name yields the same signature as the prose rule.
  const sigByName = await computeHeaderSignature("orgill.xlsx", buffer, "Timecard");
  assert.equal(sigSelected, sigByName);
});

test("recorder infers roles from the selected sheet and records its name", () => {
  const buffer = buildOrgillLikeXlsx();
  const roles = inferColumnRoles(
    buffer,
    {
      rawBadge: "90098522",
      dateIso: "2026-07-06",
      clockIn: "2026-07-06 5:59 AM",
      clockOut: "2026-07-06 6:30 PM",
      name: "Chisley, Marice N",
      hours: 12,
    },
    ORGILL_SELECTOR,
  );
  assert.ok(roles, "roles inferred from the timecard sheet");
  assert.equal(roles.sheet, "Timecard", "records which sheet it used");
  // Timecard columns: 0=Employee ID,1=Full Name,2=Apply date,3=Start,4=End,5=Total
  assert.equal(roles.badge, 0);
  assert.equal(roles.date, 2);
  assert.equal(roles.timeIn, 3);
  assert.equal(roles.timeOut, 4);
  assert.equal(roles.hours, 5, "pins the Total column");
});

test("reader opens the recorded sheet and honors its Total column (12.0, not the raw span)", () => {
  const buffer = buildOrgillLikeXlsx();
  const roles = {
    badge: 0,
    date: 2,
    timeIn: 3,
    timeOut: 4,
    hours: 5,
    name: 1,
    sheet: "Timecard",
  };
  const idMap = { "90098522": "K-CHISLEY" };
  const parsed = readWithRoles(
    "Orgill",
    buffer,
    roles,
    new Set(["K-CHISLEY"]),
    idMap,
    "2026-07-05", // Sunday
    "2026-07-11", // Saturday
  );
  assert.ok(parsed, "readWithRoles returns a ParseResult");
  assert.equal(parsed.punches.length, 2, "both in-window timecard rows");
  assert.equal(parsed.punches[0].kfiId, "K-CHISLEY");
  assert.equal(parsed.punches[0].hours, 12, "Total column honored, break netted");
});

test("reader without a stored sheet falls back to sheet 1 (legacy recipe) and does NOT find timecard punches", () => {
  const buffer = buildOrgillLikeXlsx();
  // Legacy recipe: no `sheet` → reads Master External (sheet 1), whose
  // columns don't line up with these role indices, so the badge column
  // (index 0 = "Orgill, Inc." text) never matches the timecard badge.
  const legacyRoles = { badge: 0, date: 2, timeIn: 3, timeOut: 4, hours: 5 };
  const parsed = readWithRoles(
    "Orgill",
    buffer,
    legacyRoles,
    new Set(["K-CHISLEY"]),
    { "90098522": "K-CHISLEY" },
    "2026-07-05",
    "2026-07-11",
  );
  assert.ok(parsed);
  assert.equal(
    parsed.punches.length,
    0,
    "reading sheet 1 yields no valid timecard punches — this is exactly what the sheet field fixes",
  );
});
