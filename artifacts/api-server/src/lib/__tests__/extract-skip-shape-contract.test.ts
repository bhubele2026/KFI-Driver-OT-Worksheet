// Regression pin for Task #381: when a per-row customer-file upload
// matches the SHA-256 hash of the last successful import for the same
// (week, customer), POST /weeks/:weekStart/extract-customer-file
// short-circuits and returns a JSON body with a very specific shape.
//
// The frontend has two callers — the bulk `doOneShot` path (already
// branches on `preview.skipped`) and the per-row `extractFor` wrapper
// in components/customer-upload-panel.tsx. Before #381, the per-row
// wrapper blindly fed this skip response into the preview dialog,
// which rendered a 0-row preview for Burnett (xlsx) and DeLallo (pdf)
// and then triggered `DELETE /…/extract-customer-file/null` (400) on
// cancel.
//
// This source-level guard pins the skip-branch contract so any future
// change to the response shape requires updating every caller. The
// asserted fields are:
//   - `skipped: true`            — the discriminator every caller must check
//   - `sampleId: null`           — no AI sample was written; do NOT DELETE this
//   - `rows: []`                 — never render this as a preview
//   - `unmappedIds: []`          — keep the field shape stable for clients
//   - `existingPunchCount: 0`    — no parsing happened
//   - `customer`, `fileName`, `weekStart` — for toast / log context
//
// We assert these by reading the route source and matching the literal
// `res.json({ ... })` block, which is the cheapest, hermetic way to
// pin the contract without booting express + DB + Connecteam mocks
// just for a one-branch shape check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEEKS_ROUTE_PATH = resolve(__dirname, "../../routes/weeks.ts");

test("extract-customer-file same-bytes skip branch emits the exact shape every caller depends on (Task #381)", () => {
  const src = readFileSync(WEEKS_ROUTE_PATH, "utf8");
  // Pull out the single `res.json({...})` block that lives inside the
  // `if (!force) { ... }` arm of the content-hash skip check. Anchored
  // on the rare `skipped: true` literal so the slice is unambiguous.
  const blockMatch = src.match(/res\.json\(\{[^}]*skipped:\s*true[^}]*\}\)/);
  assert.ok(
    blockMatch,
    "weeks.ts must contain a `res.json({ ..., skipped: true, ... })` call for the same-bytes skip branch",
  );
  const block = blockMatch![0];

  // Every per-row + bulk caller depends on these fields. Adding new
  // fields is fine; renaming or dropping any of them silently breaks
  // the preview dialog (per-row) or the bulk skipped counter.
  const required: Array<[label: string, pattern: RegExp]> = [
    ["skipped: true", /\bskipped:\s*true\b/],
    ["sampleId: null", /\bsampleId:\s*null\b/],
    ["rows: []", /\brows:\s*\[\s*\]/],
    ["unmappedIds: []", /\bunmappedIds:\s*\[\s*\]/],
    ["existingPunchCount: 0", /\bexistingPunchCount:\s*0\b/],
    ["customer", /\bcustomer\b/],
    ["fileName", /\bfileName\b/],
    ["weekStart", /\bweekStart\b/],
  ];
  for (const [label, pattern] of required) {
    assert.match(
      block,
      pattern,
      `same-bytes skip response must include \`${label}\` — change the field and every per-row / bulk caller must be updated in lockstep`,
    );
  }
});

test("extract-customer-file skip branch only fires when `force` is unset — per-row Re-upload (force=1) must keep going (Task #381)", () => {
  const src = readFileSync(WEEKS_ROUTE_PATH, "utf8");
  // The skip branch is gated by `if (!force)` so the per-row "Re-upload"
  // button (which passes `?force=1`) always falls through to a real
  // preview. Pin this so a future refactor doesn't accidentally drop the
  // gate and start short-circuiting Re-upload too.
  const gateAndJson = src.match(
    /if\s*\(\s*!\s*force\s*\)\s*\{\s*res\.json\(\{[^}]*skipped:\s*true/,
  );
  assert.ok(
    gateAndJson,
    "skip-branch `res.json({...skipped:true...})` must live inside an `if (!force) { ... }` arm so per-row Re-upload bypasses it",
  );
});

test("per-row `extractFor` wrapper must branch on `data.skipped` and not enqueue an empty preview (Task #381)", () => {
  // The third leg of the regression: the server contract is correct
  // (it returns `skipped:true, sampleId:null, rows:[]`), but the
  // per-row caller used to ignore `skipped` and render a 0-row preview
  // dialog. Pin the call site so a refactor can't silently regress.
  const panelPath = resolve(
    __dirname,
    "../../../../kfi-ot/src/components/customer-upload-panel.tsx",
  );
  const panel = readFileSync(panelPath, "utf8");
  assert.match(
    panel,
    /data\.skipped/,
    "customer-upload-panel.tsx per-row extract must branch on `data.skipped` — otherwise the same-bytes response would render as an empty preview dialog",
  );
  assert.match(
    panel,
    /alreadyImportedTitle/,
    "customer-upload-panel.tsx must surface the alreadyImported toast for the skip case",
  );
});
