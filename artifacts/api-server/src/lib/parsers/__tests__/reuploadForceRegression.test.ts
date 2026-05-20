/**
 * Task #358 source-line guard for the per-row Re-upload contract.
 *
 * The fix touches three call sites that an unsuspecting refactor could
 * easily unwind:
 *
 *   1. `/extract-customer-file` must honor `?force=1` by looking up the
 *      prior content hash anyway and either short-circuiting (no force)
 *      or marking the preview (`sameAsLastImport: true`). If the lookup
 *      moves back inside an `if (!force)` block, the force path silently
 *      stops flagging same-bytes re-uploads and the dialog loses its
 *      "matches the last import" note.
 *   2. The preview response must include `sameAsLastImport` — without it
 *      the dialog can't render the neutral banner.
 *   3. The customer-upload-panel's per-row file input and drop handler
 *      must pass `{ force: ... }` based on the row's `uploaded` state.
 *      If anyone deletes the option arg from `extractFor`, identical
 *      bytes go back to short-circuiting and the button looks broken.
 *
 * These aren't reachable from a true unit test (full express + DB +
 * React stack), so we read the source files and assert the load-bearing
 * code patterns are still present. A failure here means a regression
 * landed in one of the three spots above.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEEKS_ROUTE_PATH = resolve(__dirname, "../../../routes/weeks.ts");
const PANEL_PATH = resolve(
  __dirname,
  "../../../../../kfi-ot/src/components/customer-upload-panel.tsx",
);

test("extract-customer-file looks up prior hash regardless of force", () => {
  const src = readFileSync(WEEKS_ROUTE_PATH, "utf8");
  // The lookup gate must be `!isImage && detectedForSkip` — not
  // `!isImage && !force && detectedForSkip`. Asserting on the
  // pre-change pattern catches anyone who reverts the refactor.
  assert.match(
    src,
    /if\s*\(\s*!isImage\s*&&\s*detectedForSkip\s*\)/,
    "the prior-hash lookup must run regardless of `force` so the force path can set `sameAsLastImport`. If the gate becomes `!isImage && !force && detectedForSkip`, the per-row Re-upload preview loses its 'matches the last import' note (Task #358).",
  );
});

test("extract-customer-file sets sameAsLastImport on the force-hit branch", () => {
  const src = readFileSync(WEEKS_ROUTE_PATH, "utf8");
  // Whitespace-tolerant: the assignment itself must survive any
  // reformatting. If it disappears the response always reports false
  // and the dialog never shows the neutral note even on a true
  // same-bytes re-upload.
  assert.match(
    src,
    /sameAsLastImport\s*=\s*true/,
    "the force-and-match branch must set `sameAsLastImport = true` (Task #358).",
  );
  // And the response payload must include the field — easy to drop in
  // a future res.json refactor.
  assert.match(
    src,
    /sameAsLastImport\s*,/,
    "the /extract-customer-file response must include `sameAsLastImport` so the preview dialog can render the neutral banner (Task #358).",
  );
});

test("customer-upload-panel always forces on user-initiated row uploads", () => {
  const src = readFileSync(PANEL_PATH, "utf8");
  // Task #384 follow-up: every UI upload entry point (Upload button,
  // Re-upload button, per-row drop) now passes `force: true`
  // unconditionally so the server's same-bytes skip never silently
  // suppresses a re-upload. The original Task #358 nuance (only force
  // when `uploaded` was already true) confused dispatchers who
  // expected their re-upload to replace the data either way.
  assert.match(
    src,
    /extractFor\s*\(\s*s\.customer\s*,\s*f\s*,\s*\{\s*force:\s*true\s*\}\s*\)/,
    "the per-row file input must call `extractFor(s.customer, f, { force: true })` so identical bytes always open the preview to replace.",
  );
  assert.match(
    src,
    /extractFor\s*\(\s*customer\s*,\s*file\s*,\s*\{\s*force:\s*true\s*\}\s*\)/,
    "the per-row drop handler must call `extractFor(customer, file, { force: true })` so identical bytes always open the preview to replace.",
  );
  // And the bulk loop too — dispatchers re-drop a folder expecting
  // it to replace whatever is there, and the prior skip-by-default
  // behavior silently left stale rows in place.
  assert.match(
    src,
    /doUpload\s*\([^)]*\{\s*[^}]*explicitCustomer:\s*true[^}]*force:\s*true[^}]*\}\s*\)/s,
    "the bulk upload loop must pass `force: true` to `doUpload` so identical files in the folder still replace the existing rows.",
  );
});

test("customer-upload-panel does not silently re-introduce an unused uploadFor helper", () => {
  // The original (pre-task) panel had a `uploadFor` helper that did
  // a one-shot upload (no preview) and forced unconditionally. It was
  // dead code — no caller referenced it — and its presence next to the
  // real `extractFor` was confusing during the Task #358 fix. We
  // removed it; this guard makes sure it doesn't drift back in. If
  // someone genuinely wants a one-shot upload back, they should wire
  // a real caller in the same change.
  const src = readFileSync(PANEL_PATH, "utf8");
  assert.equal(
    /\buploadFor\s*\(/.test(src),
    false,
    "the unused `uploadFor` helper was removed in Task #358 — if you bring it back, wire a real caller so it doesn't drift into dead code again.",
  );
});
