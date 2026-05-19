/**
 * PDF role-inference drift suite (Task #260).
 *
 * The parser drift suite in `parsers.test.ts` runs the hand-written
 * legacy parsers against golden PDF fixtures (IWG.pdf, DeLallo.pdf) so a
 * vendor format change fails CI loudly. But with the PDF role-cache
 * fast path (Task #257), a *subtle* layout change won't be caught by
 * that suite — once the cache row is written, the route's `cache`
 * branch reads through `readPdfWithRoles`, and if the inferred regex
 * templates silently stop matching the new layout the reader returns
 * 0 rows and the route falls back to AI. The pre-merge gate would
 * never notice.
 *
 * This suite feeds each PDF-format customer's golden fixture through
 * the cache pipeline end-to-end:
 *
 *   1. Run the legacy deterministic parser to capture the "truth"
 *      punch list (a stand-in for what the AI would have emitted on
 *      the first upload — AI isn't deterministic and requires Gemini
 *      access, so the legacy parser plays the role of ground truth).
 *   2. Hand the first punch to `inferPdfColumnRoles` to derive the
 *      `employeeAnchor` + `dataRow` regex templates the AI recorder
 *      would have persisted.
 *   3. Compute `computeHeaderSignature` to confirm the PDF produces a
 *      stable cache key.
 *   4. Feed the inferred roles back to `readPdfWithRoles` and assert
 *      the punches match the truth list, point for point.
 *
 * If a fixture refresh changes a customer's PDF layout in a way that
 * breaks the inference pipeline (e.g. the vendor adds a column, moves
 * the badge, switches date format), this suite fails at the role
 * inference or the round-trip diff step — long before a dispatcher
 * uploads it and silently gets zero rows.
 *
 * Coverage:
 *   - IWG.pdf — digital PDF, full round-trip exercised.
 *   - DeLallo.pdf — scanner-produced (no text layer); the test pins
 *     that `extractPdfLinesByPage` correctly returns null so role
 *     inference can never write a bogus cache row for a scanned PDF
 *     (which would then poison every subsequent upload's `cache`
 *     branch with 0 rows).
 *
 * Adient.pdf is intentionally not in the fixtures: the customer
 * migrated to a Kronos xlsx pivot export, and the legacy
 * `parseAdientPDF` path is no longer fed by real uploads. Synthesized
 * Adient-style PDF round-trip is already pinned by
 * `pdfSchemaCacheRoundtrip.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseIWGPDF } from "../pdf.js";
import { UnmappedIdAccumulator } from "../types.js";
import type { ParsedPunch } from "../types.js";
import { EMBEDDED_MAPPING, IWG_DRIVER_IDS } from "../../mappings.js";
import {
  computeHeaderSignature,
  extractPdfLinesByPage,
} from "../schemaSignature.js";
import { inferPdfColumnRoles } from "../aiSchemaRecorder.js";
import { readPdfWithRoles } from "../genericRoleReader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures");

const KFI_SET = new Set<string>([
  ...Object.values(EMBEDDED_MAPPING),
  ...IWG_DRIVER_IDS,
]);

test("IWG.pdf: role inference reproduces legacy parser punches via readPdfWithRoles", async () => {
  const weekStart = "2026-04-26";
  const weekEnd = "2026-05-02";
  const buf = readFileSync(path.join(fixtureDir, weekStart, "IWG.pdf"));

  // Step 1: capture the deterministic legacy-parser punch list (truth).
  const unmapped = new UnmappedIdAccumulator();
  const truth = await parseIWGPDF(buf, KFI_SET, unmapped, EMBEDDED_MAPPING);
  assert.ok(truth.length > 0, "legacy IWG parser should produce punches");

  // Step 2: confirm a stable signature is computable (cache key precondition).
  const signature = await computeHeaderSignature("IWG.pdf", buf);
  assert.ok(signature, "IWG.pdf must produce a header signature for caching");
  // Re-computing on the same bytes must yield the same hash (sanity).
  const signature2 = await computeHeaderSignature("IWG.pdf", buf);
  assert.equal(signature, signature2, "signature must be deterministic");

  // Step 3: infer roles from the first truth punch. The recorder needs
  // a `rawBadge` — the IWG legacy parser maps badge → kfiId, so we
  // recover the raw badge by reverse-lookup against EMBEDDED_MAPPING
  // (IWG badges are 6-digit ids that round-trip cleanly).
  const first = truth[0];
  const rawBadge = lookupRawBadge(first.kfiId);
  assert.ok(rawBadge, `couldn't recover raw badge for kfiId=${first.kfiId}`);
  const roles = await inferPdfColumnRoles(
    buf,
    {
      rawBadge,
      clockIn: first.clockIn,
      clockOut: first.clockOut,
      hours: first.hours,
    },
    parseInt(weekStart.slice(0, 4)),
  );
  assert.ok(
    roles,
    "inferPdfColumnRoles should derive templates from a real IWG PDF",
  );
  // Step 4: round-trip through the role reader and diff against truth.
  // The truth list spans multiple employees, so a successful match
  // here implicitly proves the employee anchor generalizes — if it
  // only matched the seed employee, the replayed list would contain
  // exactly that employee's punches and the count would diverge.
  const replayed = await readPdfWithRoles(
    "International Wire Group",
    buf,
    roles,
    KFI_SET,
    EMBEDDED_MAPPING,
    weekStart,
    weekEnd,
  );
  assert.ok(replayed, "readPdfWithRoles should return a ParseResult");
  assertPunchesMatch(replayed.punches, truth, "IWG.pdf");
});

test("DeLallo.pdf: scanned PDF refuses to produce roles (cache stays safe)", async () => {
  const weekStart = "2026-04-26";
  const buf = readFileSync(path.join(fixtureDir, weekStart, "DeLallo.pdf"));

  // Scanned PDFs have no extractable text layer. The signature path,
  // the line extractor, and the role inference must all refuse to
  // produce cacheable data — otherwise the AI recorder would write a
  // bogus role row that turns every subsequent DeLallo upload into a
  // silent 0-row import (the route's cache branch would short-circuit
  // before AI ever runs).
  const pages = await extractPdfLinesByPage(buf);
  assert.equal(
    pages,
    null,
    "extractPdfLinesByPage must return null for a scanned PDF — " +
      "if this starts returning text, DeLallo.pdf has been replaced " +
      "with a digital export and this test plus the OCR fallback need " +
      "to be reconsidered",
  );

  const signature = await computeHeaderSignature("DeLallo.pdf", buf);
  assert.equal(
    signature,
    null,
    "scanned-PDF signature must be null so no cache row is keyed against it",
  );

  // Even if a caller hands us a plausible-looking sample (e.g. from an
  // OCR-driven AI extract), the inference must refuse because there's
  // no text to anchor regexes against.
  const roles = await inferPdfColumnRoles(
    buf,
    {
      rawBadge: "3619",
      clockIn: "2026-04-27 6:00 AM",
      clockOut: "2026-04-27 2:30 PM",
      hours: 8.5,
    },
    2026,
  );
  assert.equal(
    roles,
    null,
    "inferPdfColumnRoles must return null on a scanned PDF",
  );

  // And if a stale cache row somehow exists (e.g. from a prior digital
  // upload that was later replaced with a scan), the reader returns
  // null so the route falls through to AI/OCR instead of emitting 0.
  const readBack = await readPdfWithRoles(
    "DeLallo",
    buf,
    {
      format: "pdf",
      employeeAnchor: { regex: "Badge\\s*[#:]+\\s*(\\d+)" },
      dataRow: { regex: "(\\d{1,2}:\\d{2}\\s*[AP]M).*?(\\d{1,2}:\\d{2}\\s*[AP]M)" },
    },
    new Set(["2005000"]),
    { "3619": "2005000" },
    "2026-04-26",
    "2026-05-02",
  );
  assert.equal(
    readBack,
    null,
    "readPdfWithRoles must return null on a PDF with no extractable text " +
      "(forces the route to fall back to AI/OCR)",
  );
});

/**
 * Compare two punch lists for drift between the role-reader and the
 * legacy parser. We sort by (kfiId, date, clockIn) so trivial ordering
 * differences don't flap, but every field must match — a single hour
 * or minute drift means the layout changed and the inference no
 * longer captures the right column.
 */
function assertPunchesMatch(
  got: ParsedPunch[],
  want: ParsedPunch[],
  label: string,
): void {
  const sortKey = (p: ParsedPunch) => `${p.kfiId}|${p.date}|${p.clockIn}`;
  const g = [...got].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const w = [...want].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  assert.equal(
    g.length,
    w.length,
    `${label}: role-reader emitted ${g.length} punches, legacy parser ${w.length}`,
  );
  for (let i = 0; i < w.length; i++) {
    assert.equal(g[i].kfiId, w[i].kfiId, `${label}[${i}] kfiId drift`);
    assert.equal(g[i].date, w[i].date, `${label}[${i}] date drift`);
    assert.equal(g[i].clockIn, w[i].clockIn, `${label}[${i}] clockIn drift`);
    assert.equal(g[i].clockOut, w[i].clockOut, `${label}[${i}] clockOut drift`);
    // Hours can come from the regex capture (group 3) or be re-computed
    // by diffHours; either way they must round-trip to the same value
    // the legacy parser reported.
    assert.ok(
      Math.abs(g[i].hours - w[i].hours) < 0.02,
      `${label}[${i}] hours drift: ${g[i].hours} vs ${w[i].hours}`,
    );
  }
}

/**
 * Reverse-lookup the raw badge that maps to a kfiId in EMBEDDED_MAPPING.
 * IWG badges round-trip 1:1 through the mapping, so this gives us the
 * string the role recorder would have seen as `rawBadge`.
 */
function lookupRawBadge(kfiId: string): string | null {
  for (const [badge, mapped] of Object.entries(EMBEDDED_MAPPING)) {
    if (mapped === kfiId) return badge;
  }
  return null;
}
