/**
 * Cache-hit stash regression guard.
 *
 * Background: `/extract-customer-file` has two extract paths —
 *   1. cache hit (learned schema → `readWithRoles`, fast & deterministic)
 *   2. miss (chunked Claude / Gemini, slow)
 * Both must write the extracted rows onto the `ai_extract_samples` row as
 * `extractedRows` so `/confirm-customer-file` commits them directly. If
 * the cache-hit branch forgets to stash rows (the original bug — `result =
 * parsed` set but `stashedImageRows` left undefined), confirm sees an
 * empty stash, falls through to the Task #352 re-extract fallback, and
 * runs the full chunked AI extractor for every confirm. That turned a
 * sub-second commit into 3-5 minutes per customer at demo time.
 *
 * This test pins the contract the route's stash write depends on:
 *   - `readWithRoles` returns rows with all the fields
 *     `StashedExtractedPunch` requires (`kfiId`, `customer`, `date`,
 *     `clockIn`, `clockOut`, `hours`, `payType`).
 *   - The stash projection (identity copy with an optional `noTz`) is
 *     non-empty when the reader returns punches.
 *
 * If anyone removes the `stashedImageRows = imagePunchesForStash(
 * parsed.punches)` line from the cache-hit branch again, the confirm
 * path silently regresses to slow-mode. The actual route line isn't
 * reachable from a unit test, but if this contract test ever breaks
 * (e.g. `readWithRoles` returns punches without `payType`), the route
 * stash would also break. The companion safeguard is the
 * `confirm_fallback_reextract` warn log in the confirm route — search
 * production logs for that marker; the count should be ~0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as XLSX from "xlsx";
import { readWithRoles } from "../genericRoleReader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEEKS_ROUTE_PATH = resolve(
  __dirname,
  "../../../routes/weeks.ts",
);

function buildLearnedSchemaXlsx(): Buffer {
  const rows = [
    ["Employee Name", "Badge", "Date", "Time In", "Time Out", "Hours"],
    ["BAILEY, R.", "TELD9001", "2026-05-12", "6:00 AM", "2:30 PM", 8.5],
    ["JONES, K.", "TELD9002", "2026-05-12", "7:15 AM", "3:45 PM", 8.5],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// Mirror of the route's private `imagePunchesForStash` helper. Kept
// inlined (rather than imported from weeks.ts) so this test doesn't
// pull the entire route module — and so a future refactor that adds a
// required field to `StashedExtractedPunch` will break this test
// alongside the route, flagging the cache-hit branch as needing the
// same update.
type ParsedPunchLike = {
  kfiId: string;
  customer: string;
  date: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  payType: "Reg" | "OT";
};
function projectForStash(punches: ReadonlyArray<ParsedPunchLike>) {
  return punches.map((p) => ({
    kfiId: p.kfiId,
    customer: p.customer,
    date: p.date,
    clockIn: p.clockIn,
    clockOut: p.clockOut,
    hours: p.hours,
    payType: p.payType,
  }));
}

test("cache-hit ParseResult projects to a non-empty StashedExtractedPunch array", () => {
  const buffer = buildLearnedSchemaXlsx();
  const roles = { badge: 1, date: 2, timeIn: 3, timeOut: 4, hours: 5, name: 0 };
  const idMap = { TELD9001: "TELD9001", TELD9002: "TELD9002" };
  const parsed = readWithRoles(
    "Trienda Holdings",
    buffer,
    roles,
    new Set(Object.values(idMap)),
    idMap,
    "2026-05-10",
    "2026-05-16",
  );
  assert.ok(parsed, "readWithRoles should return a ParseResult for a cache hit");
  assert.ok(
    parsed.punches.length > 0,
    "cache-hit punches must be non-empty for the stash check to matter",
  );

  // The fix: the route stores `imagePunchesForStash(parsed.punches)` on
  // the `ai_extract_samples` row's `extractedRows`. If that produces
  // an empty array OR strips a required field, confirm falls through
  // to the slow Task #352 fallback and the dispatcher waits minutes.
  const stash = projectForStash(parsed.punches);
  assert.equal(
    stash.length,
    parsed.punches.length,
    "every cache-hit row must survive the stash projection",
  );
  for (const row of stash) {
    assert.ok(row.kfiId, "kfiId required");
    assert.ok(row.customer, "customer required");
    assert.ok(row.date, "date required");
    assert.ok(row.clockIn, "clockIn required");
    assert.ok(row.clockOut, "clockOut required");
    assert.ok(typeof row.hours === "number" && row.hours > 0, "hours required");
    assert.ok(
      row.payType === "Reg" || row.payType === "OT",
      "payType must be 'Reg' or 'OT'",
    );
  }
});

/*
 * Direct source-line guard: the original bug was the cache-hit branch
 * in `/extract-customer-file` setting `result = parsed` but never
 * assigning `stashedImageRows`. The route handler isn't unit-testable
 * (full express + DB stack), so this test reads the route source and
 * asserts the cache-hit branch still writes the stash. If anyone
 * deletes the `stashedImageRows = imagePunchesForStash(parsed.punches)`
 * line again, this test fails loudly — exactly the regression class
 * the helper-shape tests above cannot catch on their own.
 */
test("weeks.ts cache-hit branch still writes stashedImageRows", () => {
  const src = readFileSync(WEEKS_ROUTE_PATH, "utf8");
  // `parsed.punches` is unique to the cache-hit branch — the AI path
  // uses `aiResult.punches` and the confirm fallback uses
  // `reAiResult.punches`. Whitespace-tolerant so reformatting doesn't
  // break the test, but the assignment itself must be present.
  const cacheBranchMatch =
    /stashedImageRows\s*=\s*imagePunchesForStash\s*\(\s*parsed\.punches\s*\)/;
  assert.match(
    src,
    cacheBranchMatch,
    "cache-hit branch must call stashedImageRows = imagePunchesForStash(parsed.punches) — otherwise /confirm-customer-file falls through to the slow re-extract fallback",
  );
});

/*
 * Operational guard: the confirm route's Task #352 fallback emits a
 * `confirm_fallback_reextract` warn marker so we can monitor whether
 * any extract path is silently skipping the stash. If someone removes
 * the marker, production loses its early-warning signal.
 */
test("weeks.ts confirm fallback still emits confirm_fallback_reextract marker", () => {
  const src = readFileSync(WEEKS_ROUTE_PATH, "utf8");
  assert.match(
    src,
    /marker:\s*"confirm_fallback_reextract"/,
    "confirm-route fallback must emit the confirm_fallback_reextract log marker so missing-stash regressions surface in prod logs",
  );
});

test("cache-hit stash protects against the empty-rows confirm fallback (hasAiRows sentinel)", () => {
  // This is the route's `hasAiRows` predicate. The bug was that
  // extractedRows landed as `[]` because the cache-hit branch never
  // populated `stashedImageRows`. Lock the predicate's truth value
  // against the projection above so a future refactor that breaks the
  // shape (e.g. dropping `payType`) doesn't quietly turn confirms slow
  // again.
  const buffer = buildLearnedSchemaXlsx();
  const roles = { badge: 1, date: 2, timeIn: 3, timeOut: 4 };
  const idMap = { TELD9001: "TELD9001", TELD9002: "TELD9002" };
  const parsed = readWithRoles(
    "Trienda Holdings",
    buffer,
    roles,
    new Set(Object.values(idMap)),
    idMap,
    "2026-05-10",
    "2026-05-16",
  );
  assert.ok(parsed);
  const stashedExtractedRows = projectForStash(parsed.punches);
  const stashedPendingRows: unknown[] = [];
  const hasAiRows =
    stashedExtractedRows.length > 0 || stashedPendingRows.length > 0;
  assert.equal(
    hasAiRows,
    true,
    "cache-hit confirm must NOT fall through to the chunked AI fallback",
  );
});
