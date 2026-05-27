import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for task #440.
//
// `xlsxWorkerPool.ts` / `pdfWorkerPool.ts` spawn their worker_threads
// via `new URL("./xlsxWorker.mjs", import.meta.url)` — i.e. the worker
// must land as a **sibling** of the bundled `dist/index.mjs`. The
// previous esbuild config used the array form of `entryPoints`, which
// auto-detects `outbase` as the common parent (`src/`) and emits the
// workers at `dist/lib/parsers/xlsxWorker.mjs` instead. Every xlsx
// upload through the AI/cache lane (and every text-extractable PDF
// through the AI lane) then crashed with:
//   "Cannot find module '.../dist/xlsxWorker.mjs'"
//
// The tests never caught it because `resolveWorkerUrl()` short-circuits
// to `null` when running under tsx (`import.meta.url` ends in `.ts`),
// so the URL math is never exercised against the built artifact.
//
// This test:
//   1. asserts `build.mjs` uses the object-form entryPoints (so the
//      workers can never silently regress back to a nested path even
//      if a dev runs only `pnpm test` without rebuilding); and
//   2. when a built `dist/` is present (the canonical test workflow
//      runs `pnpm --filter @workspace/api-server run build` before
//      tests), asserts the expected sibling files exist on disk.
//
// `build.mjs` itself also has a post-build existsSync assertion (same
// task) that fails the build loudly if the files don't land in the
// right place — this test is defense in depth.

const here = path.dirname(fileURLToPath(import.meta.url));
const apiServerDir = path.resolve(here, "../../../..");
const buildScript = path.join(apiServerDir, "build.mjs");
const distDir = path.join(apiServerDir, "dist");

test("build.mjs uses object-form entryPoints so workers land at dist root", async () => {
  const src = await readFile(buildScript, "utf8");

  // Object form: `entryPoints: {` — array form was `entryPoints: [`.
  assert.ok(
    /entryPoints\s*:\s*\{/.test(src),
    `Expected build.mjs to use object-form entryPoints (entryPoints: { index: ..., xlsxWorker: ..., pdfWorker: ... }). The array form makes esbuild emit dist/lib/parsers/xlsxWorker.mjs, but xlsxWorkerPool.ts / pdfWorkerPool.ts resolve workers as siblings of dist/index.mjs.`,
  );
  for (const key of ["index", "xlsxWorker", "pdfWorker"]) {
    assert.ok(
      new RegExp(`${key}\\s*:\\s*path\\.resolve`).test(src),
      `Expected build.mjs entryPoints to include "${key}" → path.resolve(...).`,
    );
  }
});

test("dist/ contains sibling xlsxWorker.mjs and pdfWorker.mjs after build", () => {
  if (!existsSync(path.join(distDir, "index.mjs"))) {
    // No built dist — running `pnpm test` outside the CI/test workflow.
    // The first test above (and the in-build assertion) cover this
    // case; nothing useful to check here.
    return;
  }
  for (const file of ["index.mjs", "xlsxWorker.mjs", "pdfWorker.mjs"]) {
    const p = path.join(distDir, file);
    assert.ok(
      existsSync(p),
      `Expected ${p} to exist as a sibling of dist/index.mjs. xlsxWorkerPool.ts / pdfWorkerPool.ts resolve workers via new URL("./xlsxWorker.mjs", import.meta.url) and crash with MODULE_NOT_FOUND if the file lives elsewhere.`,
    );
  }
});
