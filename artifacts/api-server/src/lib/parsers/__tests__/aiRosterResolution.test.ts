/**
 * Task #271 — AI roster resolution.
 *
 * The AI prompt now ships a per-customer roster (kfiId + name + known
 * badges + saved aliases) and the model is asked to fill `resolvedKfiId`
 * on each row. The server-side resolver consumes that hint with three
 * guards:
 *
 *   1. Badge mapping is the source of truth. When a row carries a badge
 *      that we already know maps to a kfi, the badge wins — even if the
 *      AI picked a different driver. This is the badge-disagree guard.
 *   2. resolvedKfiId is only accepted when it points at an active kfi
 *      that's actually in the pool we sent to the prompt. Anything else
 *      is treated as a hallucination and falls through to name alias /
 *      fuzzy match.
 *   3. With no badge and no AI hint, the existing nameAliasMap / fuzzy
 *      ladder still runs — so the hint is additive, never lossy.
 *
 * Tests exercise the live `extractImageForKnownCustomer` path via the
 * `__pushAiExtractStub` seam, so no Gemini call is made and the
 * resolver branches are pinned independently of prompt content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImageForKnownCustomer } from "../imageSupport.js";
import {
  __pushAiExtractStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const driversFixture = [
  { kfiId: "K001", name: "Aaron Smith", customer: "Acme" },
  { kfiId: "K002", name: "Beatrice Lopez", customer: "Acme" },
  { kfiId: "K999", name: "Other Driver", customer: "OtherCo" },
];
const kfiSet = new Set(driversFixture.map((d) => d.kfiId));

function makeArgs(overrides: {
  stub: Array<Record<string, unknown>>;
  idMap?: Record<string, string>;
  nameAliasMap?: Map<string, string>;
}) {
  __clearAiExtractStubs();
  __pushAiExtractStub(overrides.stub as never);
  return {
    args: {
      fileName: "photo.png",
      buffer: PNG,
      mimeType: "image/png",
      customer: "Acme",
      weekStart: "2026-05-10",
      weekEnd: "2026-05-16",
      drivers: driversFixture,
      kfiSet,
      idMap: overrides.idMap ?? {},
      nameAliasMap: overrides.nameAliasMap,
    },
  };
}

test("Task #271: AI's resolvedKfiId is honored when it points at a known driver in the roster pool", async () => {
  const { args } = makeArgs({
    stub: [
      {
        driverNameOnDoc: "B. Lopez",
        date: "2026-05-12",
        timeIn: "07:00",
        timeOut: "15:00",
        resolvedKfiId: "K002",
      },
    ],
  });
  const result = await extractImageForKnownCustomer(args);
  assert.equal(result.punches.length, 1);
  assert.equal(result.punches[0].kfiId, "K002");
  assert.equal(result.unmappedIds.length, 0);
});

test("Task #271: badge mapping wins over AI's resolvedKfiId (badge-disagree guard)", async () => {
  // The AI claims this row belongs to K002, but badge 7700 is already
  // mapped to K001 in the live id map. We must trust the badge.
  const { args } = makeArgs({
    stub: [
      {
        driverNameOnDoc: "B. Lopez",
        badgeOrId: "7700",
        date: "2026-05-12",
        timeIn: "07:00",
        timeOut: "15:00",
        resolvedKfiId: "K002",
      },
    ],
    idMap: { "7700": "K001" },
  });
  const result = await extractImageForKnownCustomer(args);
  assert.equal(result.punches.length, 1);
  assert.equal(result.punches[0].kfiId, "K001");
});

test("Task #271: AI's resolvedKfiId is rejected as hallucination when it picks a driver outside the customer pool", async () => {
  // K999 is in the active roster but attached to OtherCo, so it never
  // appears in the pool we sent to the prompt for Acme. The hint must
  // fall through; the row ends up in pendingNamedRows.
  const { args } = makeArgs({
    stub: [
      {
        driverNameOnDoc: "Stranger Name",
        date: "2026-05-12",
        timeIn: "07:00",
        timeOut: "15:00",
        resolvedKfiId: "K999",
      },
    ],
  });
  const result = await extractImageForKnownCustomer(args);
  assert.equal(result.punches.length, 0);
  assert.equal(result.pendingNamedRows.length, 1);
  assert.equal(result.unmappedIds.length, 1);
  // The unmapped entry is encoded as name:<DriverNameOnDoc> for the
  // /confirm-customer-file picker.
  assert.equal(result.unmappedIds[0].id, "name:Stranger Name");
});

test("Task #271: AI's resolvedKfiId is rejected when target kfi isn't in the active roster at all", async () => {
  const { args } = makeArgs({
    stub: [
      {
        driverNameOnDoc: "Unknown Name",
        date: "2026-05-12",
        timeIn: "07:00",
        timeOut: "15:00",
        resolvedKfiId: "K404", // not in kfiSet
      },
    ],
  });
  const result = await extractImageForKnownCustomer(args);
  assert.equal(result.punches.length, 0);
  assert.equal(result.pendingNamedRows.length, 1);
});

test("Task #271: badge-disagree guard is case-insensitive (TELD vs teld)", async () => {
  // Historical mapping was stored as upper-case TELD123 → K001.
  // The customer doc spelled the same badge as lowercase `teld123`
  // and the AI tried to attribute it to K002. The guard must still
  // fire — otherwise the disagree case slips past whenever the
  // dispatcher's photo / spreadsheet uses a different casing than
  // the DB row.
  const { args } = makeArgs({
    stub: [
      {
        driverNameOnDoc: "B. Lopez",
        badgeOrId: "teld123",
        date: "2026-05-12",
        timeIn: "07:00",
        timeOut: "15:00",
        resolvedKfiId: "K002",
      },
    ],
    idMap: { TELD123: "K001" },
  });
  const result = await extractImageForKnownCustomer(args);
  assert.equal(result.punches.length, 1);
  assert.equal(result.punches[0].kfiId, "K001");
});

test("Task #271: nameAliasMap still resolves rows the AI didn't tag", async () => {
  const aliasMap = new Map<string, string>([["b lopez", "K002"]]);
  const { args } = makeArgs({
    stub: [
      {
        driverNameOnDoc: "B Lopez",
        date: "2026-05-12",
        timeIn: "07:00",
        timeOut: "15:00",
        // No resolvedKfiId — model omitted it.
      },
    ],
    nameAliasMap: aliasMap,
  });
  const result = await extractImageForKnownCustomer(args);
  assert.equal(result.punches.length, 1);
  assert.equal(result.punches[0].kfiId, "K002");
});
