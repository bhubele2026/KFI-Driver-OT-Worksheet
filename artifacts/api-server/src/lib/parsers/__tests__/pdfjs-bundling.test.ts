import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the pdfjs-dist bundling trap (task #184).
//
// esbuild bundles `pdfjs-dist` into `dist/index.mjs` by default. At runtime,
// pdfjs's "fake worker" path does `await import("./pdf.worker.mjs")` relative
// to its own module location — which, once bundled, resolves to
// `dist/pdf.worker.mjs` (does not exist) instead of
// `node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`. Every PDF upload
// (IWG, DeLallo, Adient) then dies with:
//   "Setting up fake worker failed: Cannot find module '.../dist/pdf.worker.mjs'"
//
// Fix: keep `pdfjs-dist` (and the legacy + worker subpaths) in the `external`
// array of `build.mjs` so they resolve from `node_modules/` at runtime.
//
// This test statically parses `build.mjs` and fails fast if any of those
// externals is removed.

const REQUIRED_EXTERNALS = [
  "pdfjs-dist",
  "pdfjs-dist/legacy/build/pdf.mjs",
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
];

test("build.mjs keeps pdfjs-dist externalized so the fake worker can find pdf.worker.mjs", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const buildScript = path.resolve(here, "../../../../build.mjs");
  const src = await readFile(buildScript, "utf8");

  for (const ext of REQUIRED_EXTERNALS) {
    assert.ok(
      src.includes(`"${ext}"`),
      `Expected ${buildScript} to externalize "${ext}". If it gets bundled, pdfjs's fake worker can't resolve pdf.worker.mjs relative to dist/index.mjs and every PDF upload fails with "Setting up fake worker failed".`,
    );
  }
});
