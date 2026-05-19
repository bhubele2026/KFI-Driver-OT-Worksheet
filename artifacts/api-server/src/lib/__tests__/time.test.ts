import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTime12, fmtDT } from "../time.js";

test("fmtDT: Excel serial midnight → 12:00 AM", () => {
  // 45773 = 2025-04-26 00:00 UTC.
  assert.equal(fmtDT(45773), "2025-04-26 12:00 AM");
});

test("fmtDT: Excel serial noon → 12:00 PM", () => {
  assert.equal(fmtDT(45773 + 0.5), "2025-04-26 12:00 PM");
});

test("fmtDT: Excel serial single-digit hour → no leading zero", () => {
  // 13:05 UTC == 1:05 PM.
  assert.equal(fmtDT(45773 + 13 / 24 + 5 / 1440), "2025-04-26 1:05 PM");
});

test("fmtDT: ISO string → 12-hour", () => {
  // Use a UTC ISO and a UTC TZ for the host so this is deterministic.
  // The parsers store wall-clock strings, so the actual TZ of the
  // server doesn't matter much in practice — what matters is that the
  // format is `h:MM AM/PM`. Use a literal that doesn't cross noon in
  // any TZ to stay deterministic across hosts.
  const out = fmtDT("2026-04-26T08:30:00");
  assert.match(out, /^2026-04-26 \d{1,2}:\d{2} (AM|PM)$/);
});

test("fmtDT: 24-hour combined string with seconds → 12-hour, no seconds", () => {
  assert.equal(fmtDT("2026-04-26 13:28:00"), "2026-04-26 1:28 PM");
});

test("fmtDT: 24-hour combined string without seconds → 12-hour", () => {
  assert.equal(fmtDT("2026-04-26 09:05"), "2026-04-26 9:05 AM");
});

test("fmtDT: 00:00 → 12:00 AM, 12:00 → 12:00 PM", () => {
  assert.equal(fmtDT("2026-04-26 00:00:00"), "2026-04-26 12:00 AM");
  assert.equal(fmtDT("2026-04-26 12:00:00"), "2026-04-26 12:00 PM");
});

test("fmtDT: already-12-hour input passes through (idempotent), normalized", () => {
  assert.equal(fmtDT("2026-04-26 5:55 AM"), "2026-04-26 5:55 AM");
  // Leading-zero hour gets stripped to match the canonical shape.
  assert.equal(fmtDT("2026-04-26 05:55 AM"), "2026-04-26 5:55 AM");
  assert.equal(fmtDT("2026-04-26 02:00 PM"), "2026-04-26 2:00 PM");
});

test("fmtDT: empty/null returns empty string", () => {
  assert.equal(fmtDT(null), "");
  assert.equal(fmtDT(undefined), "");
  assert.equal(fmtDT(""), "");
});

test("fmtDT: Date object → 12-hour", () => {
  // Construct a Date with a known local time so the conversion to
  // local 12-hour is deterministic on every host.
  const d = new Date(2026, 3, 26, 8, 30); // Apr is month index 3
  assert.equal(fmtDT(d), "2026-04-26 8:30 AM");
  const d2 = new Date(2026, 3, 26, 0, 0);
  assert.equal(fmtDT(d2), "2026-04-26 12:00 AM");
  const d3 = new Date(2026, 3, 26, 12, 0);
  assert.equal(fmtDT(d3), "2026-04-26 12:00 PM");
  const d4 = new Date(2026, 3, 26, 13, 5);
  assert.equal(fmtDT(d4), "2026-04-26 1:05 PM");
});

test("ensureTime12: 24-hour → 12-hour", () => {
  assert.equal(ensureTime12("13:28:00"), "1:28 PM");
  assert.equal(ensureTime12("13:28"), "1:28 PM");
  assert.equal(ensureTime12("00:05"), "12:05 AM");
  assert.equal(ensureTime12("12:00"), "12:00 PM");
});

test("ensureTime12: 12-hour passes through (leading-zero stripped)", () => {
  assert.equal(ensureTime12("5:55 AM"), "5:55 AM");
  assert.equal(ensureTime12("05:55 AM"), "5:55 AM");
  assert.equal(ensureTime12("2:00 PM"), "2:00 PM");
});
