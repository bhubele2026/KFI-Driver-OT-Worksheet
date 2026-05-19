/**
 * Pins Task #255's per-format AI timeout policy:
 *  - images get a 90s ceiling (dispatcher is actively watching a photo);
 *  - xlsx + PDF get 5 minutes (so a first-time AI extract on a real
 *    weekly Trienda-scale export reliably completes and warms the
 *    column-roles cache for sub-100ms subsequent uploads).
 *
 * Verifies via the source text — the constant is a per-call closure, not
 * exported, but the behavior contract is explicit enough to assert as
 * a regression guard against accidentally lowering it back to 90s for
 * spreadsheets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "../aiExtract.ts"),
  "utf8",
);

test("AI timeout: images 90s, xlsx/pdf 5 minutes (Task #255)", () => {
  assert.match(
    source,
    /const AI_TIMEOUT_MS = isImage \? 90_000 : 300_000;/,
    "AI_TIMEOUT_MS must branch on isImage with 90s/300s budgets",
  );
});

test("xlsx CSV prompt cap is at least 1MB so realistic exports aren't silently truncated", () => {
  const m = source.match(/const XLSX_CSV_MAX_CHARS = ([\d_]+);/);
  assert.ok(m, "XLSX_CSV_MAX_CHARS constant must exist");
  const value = parseInt(m[1].replace(/_/g, ""), 10);
  assert.ok(
    value >= 1_000_000,
    `XLSX_CSV_MAX_CHARS should be >= 1M (was ${value})`,
  );
});
