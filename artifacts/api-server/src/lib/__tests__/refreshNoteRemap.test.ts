/**
 * B3 — note-remap mapping (Connecteam refresh replaces punches).
 *
 * Pins that a row-level note follows its shift across a refresh's
 * delete/re-insert (new punch id) — matched on ctExternalKey first, then
 * punch identity (kfiId|date|clockIn|clockOut) when the key is null.
 *
 * Pure unit test: no DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNoteRemap, type RefreshPunchRow } from "../refreshNoteRemap.js";

const row = (
  id: number,
  ctExternalKey: string | null,
  overrides: Partial<RefreshPunchRow> = {},
): RefreshPunchRow => ({
  id,
  ctExternalKey,
  kfiId: "K1",
  date: "2026-07-06",
  clockIn: "2026-07-06 6:00 AM",
  clockOut: "2026-07-06 2:30 PM",
  ...overrides,
});

test("maps deleted→inserted by ctExternalKey", () => {
  const deleted = [row(10, "ct-abc")];
  const inserted = [row(99, "ct-abc")];
  const map = computeNoteRemap(deleted, inserted);
  assert.equal(map.get(10), 99);
});

test("falls back to punch identity when key is null", () => {
  const deleted = [row(10, null)];
  const inserted = [row(99, null)];
  const map = computeNoteRemap(deleted, inserted);
  assert.equal(map.get(10), 99, "same kfiId/date/clockIn/clockOut → same shift");
});

test("key match wins over identity when both present", () => {
  // Deleted punch's key matches inserted #99 (different clock times), while
  // a different inserted #77 shares the OLD identity. Key must win.
  const deleted = [row(10, "ct-abc")];
  const inserted = [
    row(77, "ct-other", { clockOut: "2026-07-06 2:30 PM" }), // shares identity
    row(99, "ct-abc", { clockOut: "2026-07-06 2:31 PM" }), // shares key
  ];
  const map = computeNoteRemap(deleted, inserted);
  assert.equal(map.get(10), 99);
});

test("no mapping when the shift did not come back", () => {
  const deleted = [row(10, "ct-gone")];
  const inserted = [row(99, "ct-different", { clockIn: "2026-07-06 9:00 AM" })];
  const map = computeNoteRemap(deleted, inserted);
  assert.equal(map.size, 0);
});

test("omits identity mappings that resolve to the same id (no-op)", () => {
  const same = row(10, "ct-abc");
  const map = computeNoteRemap([same], [same]);
  assert.equal(map.size, 0, "old id === new id → nothing to remap");
});

test("empty inputs → empty map", () => {
  assert.equal(computeNoteRemap([], [row(1, "x")]).size, 0);
  assert.equal(computeNoteRemap([row(1, "x")], []).size, 0);
});

test("multi-driver batch remaps each independently", () => {
  const deleted = [
    row(1, "ct-a", { kfiId: "KA" }),
    row(2, "ct-b", { kfiId: "KB" }),
  ];
  const inserted = [
    row(20, "ct-b", { kfiId: "KB" }),
    row(10, "ct-a", { kfiId: "KA" }),
  ];
  const map = computeNoteRemap(deleted, inserted);
  assert.equal(map.get(1), 10);
  assert.equal(map.get(2), 20);
});
