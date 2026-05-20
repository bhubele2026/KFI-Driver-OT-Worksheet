/**
 * Cache-hit `kfiSet` symbol regression guard (Task #373).
 *
 * Background: the cache-hit branch of `/extract-customer-file` in
 * `artifacts/api-server/src/routes/weeks.ts` calls the generic role
 * reader with the in-scope `kfiSet` built from the active drivers
 * query. A previous edit accidentally referenced an undefined
 * `cacheKfiSet` symbol there instead — `pnpm run typecheck` flagged
 * `TS2304: Cannot find name 'cacheKfiSet'`, but the pre-merge gate
 * uses esbuild (which ignores type errors), so it masked the bug.
 * At runtime every cache-hit upload threw `ReferenceError`, was
 * swallowed by the surrounding try/catch, and fell through to the AI
 * extractor — defeating the whole point of the schema cache.
 *
 * Task #373 fixed the symbol and pulled the cache branch out of the
 * route into the testable `runCachedRoleReader` / `runCachedPdfRoleReader`
 * helpers. The route now delegates to those helpers, which is exactly
 * what we test below.
 *
 * The tests pin three things:
 *   1. Source guard: weeks.ts does not reference the never-defined
 *      `cacheKfiSet` symbol and routes the cache-hit branch through
 *      the new helpers.
 *   2. Functional contract: `runCachedRoleReader` invoked with a
 *      schema-cache hit for a learned xlsx layout returns committable
 *      punches — i.e. the cache path produces rows the confirm route
 *      can write directly. The helper performs zero AI work and has
 *      no I/O surface (no imports of the AI extractor, no DB) so
 *      "no AI call" is a structural property — see import guard below.
 *   3. Import guard: `runCachedRoleReader.ts` does not import any AI
 *      extractor or DB module, so the cache path structurally cannot
 *      reach AI. This is the strongest "no AI call" assertion we can
 *      make without booting the full route + DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as XLSX from "xlsx";
import {
  runCachedRoleReader,
} from "../runCachedRoleReader.js";
import type { SchemaLookupResult } from "../schemaLookup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEEKS_ROUTE_PATH = resolve(__dirname, "../../../routes/weeks.ts");
const RUN_CACHED_PATH = resolve(__dirname, "../runCachedRoleReader.ts");

test("weeks.ts cache-hit branch no longer references the undefined cacheKfiSet symbol", () => {
  const src = readFileSync(WEEKS_ROUTE_PATH, "utf8");
  assert.doesNotMatch(
    src,
    /\bcacheKfiSet\b/,
    "cache-hit branch must not reference the undefined cacheKfiSet symbol — the route now delegates to runCachedRoleReader / runCachedPdfRoleReader",
  );
  assert.match(
    src,
    /runCachedRoleReader\s*\(/,
    "cache-hit xlsx branch must call runCachedRoleReader",
  );
  assert.match(
    src,
    /runCachedPdfRoleReader\s*\(/,
    "cache-hit PDF branch must call runCachedPdfRoleReader",
  );
});

test("runCachedRoleReader.ts has no AI/DB imports — cache path structurally cannot reach AI", () => {
  const src = readFileSync(RUN_CACHED_PATH, "utf8");
  // The helper is intentionally pure (no DB, no AI). If anyone wires an
  // AI fallback in here, the route's "cache hit ⇒ no AI" contract
  // silently breaks. The whitelist below is the ONLY allowed imports.
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l));
  for (const line of importLines) {
    const bad =
      /aiExtract|claudeExtract|geminiExtract|"\.\.\/db|\/db\.js|@workspace\/db/.test(
        line,
      );
    assert.equal(
      bad,
      false,
      `runCachedRoleReader.ts must not import AI or DB modules — found: ${line.trim()}`,
    );
  }
});

test("cached xlsx schema commits via the cache path with no AI call", () => {
  // A learned-schema xlsx (header signature already in
  // customer_column_schemas) hits the cache branch in the route, which
  // delegates to `runCachedRoleReader`. We invoke that helper with the
  // same arg shape the route uses and assert it produces committable
  // punches deterministically — no Claude / Gemini call.
  const rows = [
    ["Employee Name", "Badge", "Date", "Time In", "Time Out", "Hours"],
    ["BAILEY, R.", "TELD9001", "2026-05-12", "6:00 AM", "2:30 PM", 8.5],
    ["JONES, K.", "TELD9002", "2026-05-12", "7:15 AM", "3:45 PM", 8.5],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const schemaHit: Extract<SchemaLookupResult, { kind: "cache" }> = {
    kind: "cache",
    format: "xlsx",
    headerSignature: "test-signature",
    columnRoles: { name: 0, badge: 1, date: 2, timeIn: 3, timeOut: 4, hours: 5 },
  };
  const drivers = [
    { kfiId: "TELD9001", name: "Rita Bailey", customer: "Trienda Holdings" },
    { kfiId: "TELD9002", name: "Kim Jones", customer: "Trienda Holdings" },
  ];

  const parsed = runCachedRoleReader({
    customer: "Trienda Holdings",
    buffer,
    schemaHit,
    drivers,
    idMap: { TELD9001: "TELD9001", TELD9002: "TELD9002" },
    nameAliasMap: new Map(),
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
  });

  assert.ok(parsed, "cache-path helper must return a ParseResult");
  assert.equal(parsed.punches.length, 2, "both learned-schema rows must resolve");
  for (const p of parsed.punches) {
    assert.equal(p.customer, "Trienda Holdings");
    assert.equal(p.date, "2026-05-12");
    assert.ok(["TELD9001", "TELD9002"].includes(p.kfiId));
  }
});

test("runCachedRoleReader returns null for a PDF schema hit (route handles pdf via the async helper)", () => {
  const schemaHit: Extract<SchemaLookupResult, { kind: "cache" }> = {
    kind: "cache",
    format: "pdf",
    headerSignature: "x",
    columnRoles: { name: 0, badge: 1, date: 2, timeIn: 3, timeOut: 4 },
  };
  const out = runCachedRoleReader({
    customer: "Any",
    buffer: Buffer.from([]),
    schemaHit,
    drivers: [],
    idMap: {},
    nameAliasMap: new Map(),
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
  });
  assert.equal(out, null);
});

test("runCachedRoleReader swallows reader errors and returns null (route falls through to AI)", () => {
  // Garbage buffer → XLSX.read throws → helper returns null. Mirrors the
  // route's "stale roles" recovery: a malformed cached recipe must not
  // crash the upload; the route will re-run AI which overwrites the
  // bad cache row.
  const schemaHit: Extract<SchemaLookupResult, { kind: "cache" }> = {
    kind: "cache",
    format: "xlsx",
    headerSignature: "x",
    columnRoles: { name: 0, badge: 1, date: 2, timeIn: 3, timeOut: 4 },
  };
  let warned = false;
  const out = runCachedRoleReader({
    customer: "Any",
    buffer: Buffer.from("not an xlsx"),
    schemaHit,
    drivers: [],
    idMap: {},
    nameAliasMap: new Map(),
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
    log: { warn: () => { warned = true; } },
  });
  assert.equal(out, null);
  // Either the reader returned null OR threw and we logged. Both
  // outcomes are acceptable — the contract is "null on failure".
  void warned;
});
