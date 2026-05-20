/**
 * Task #363 regression — customer "employee number" must not auto-resolve
 * to a real KFI badge when that badge belongs to a driver on a DIFFERENT
 * customer's roster.
 *
 * The production miss this test pins:
 *   - Trienda's xlsx export carries an "Employee Number" column whose
 *     ids are an unrelated namespace from Connecteam's badges.
 *   - A Trienda row for "Cortes, Natalia I" arrived with employee
 *     number `2003283`, which happens to equal the KFI badge of
 *     Felix Baez Caballero (a Burnett Dairy driver who has never
 *     worked at Trienda).
 *   - The AI / cache paths both auto-resolved that row to Felix
 *     because `kfiSet.has("2003283")` is true, silently writing 4
 *     bogus Customer-source punches over his real shifts.
 *
 * The guard (`isBadgeMatchTrustworthy`, wired into `resolveKfiId` in
 * `imageSupport.ts` and the badgeGuard arg on the cache readers in
 * `genericRoleReader.ts`) refuses a bare numeric match unless the
 * candidate driver is on the uploaded customer's roster, OR a saved
 * `customer_name_aliases` row vouches for the pair, OR the row's
 * nameOnDoc fuzzy-matches the candidate driver's name with high
 * confidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  extractImageForKnownCustomer,
} from "../imageSupport.js";
import {
  __pushAiExtractStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";
import {
  isBadgeMatchTrustworthy,
} from "../fuzzy.js";
import { readWithRoles } from "../genericRoleReader.js";

const FELIX_KFI = "2003283"; // collides with Trienda employee number
const FELIX_NAME = "Felix Baez Caballero";
const FELIX_CUSTOMER = "Burnett Dairy";

const TRIENDA = "Trienda";
const TRIENDA_NAME_ON_DOC = "Cortes, Natalia I";

test("isBadgeMatchTrustworthy rejects ID-only collisions across customers", () => {
  const driversByKfi = new Map([
    [FELIX_KFI, { name: FELIX_NAME, customer: FELIX_CUSTOMER }],
  ]);
  const ok = isBadgeMatchTrustworthy({
    candidateKfiId: FELIX_KFI,
    nameOnDoc: TRIENDA_NAME_ON_DOC,
    uploadedCustomer: TRIENDA,
    driversByKfi,
    nameAliasMap: new Map(),
  });
  assert.equal(
    ok,
    false,
    "Felix (Burnett) must not auto-resolve on a Trienda file row whose nameOnDoc is unrelated",
  );
});

test("isBadgeMatchTrustworthy accepts when driver is on the uploaded customer's roster", () => {
  const driversByKfi = new Map([
    [FELIX_KFI, { name: FELIX_NAME, customer: TRIENDA }],
  ]);
  const ok = isBadgeMatchTrustworthy({
    candidateKfiId: FELIX_KFI,
    nameOnDoc: TRIENDA_NAME_ON_DOC,
    uploadedCustomer: TRIENDA,
    driversByKfi,
    nameAliasMap: new Map(),
  });
  assert.equal(ok, true);
});

test("isBadgeMatchTrustworthy accepts when a saved name alias vouches for the pair", () => {
  const driversByKfi = new Map([
    [FELIX_KFI, { name: FELIX_NAME, customer: FELIX_CUSTOMER }],
  ]);
  const ok = isBadgeMatchTrustworthy({
    candidateKfiId: FELIX_KFI,
    nameOnDoc: TRIENDA_NAME_ON_DOC,
    uploadedCustomer: TRIENDA,
    driversByKfi,
    nameAliasMap: new Map([[TRIENDA_NAME_ON_DOC.toLowerCase(), FELIX_KFI]]),
  });
  assert.equal(
    ok,
    true,
    "a dispatcher-confirmed customer_name_aliases row overrides the collision guard",
  );
});

test("isBadgeMatchTrustworthy accepts when nameOnDoc fuzzy-matches the candidate driver", () => {
  const driversByKfi = new Map([
    [FELIX_KFI, { name: FELIX_NAME, customer: FELIX_CUSTOMER }],
  ]);
  const ok = isBadgeMatchTrustworthy({
    candidateKfiId: FELIX_KFI,
    nameOnDoc: "Felix Baez Caballero",
    uploadedCustomer: TRIENDA,
    driversByKfi,
    nameAliasMap: new Map(),
  });
  assert.equal(ok, true);
});

test("extractImageForKnownCustomer stashes Trienda collision row as pending instead of misattributing", async () => {
  __clearAiExtractStubs();
  // Stub the AI extractor to return one Trienda row whose badgeOrId
  // collides with Felix's KFI id. Without the guard this row would
  // resolve to Felix's kfiId (Burnett driver) and import as a real
  // Customer-source Trienda punch on top of his Burnett shifts.
  __pushAiExtractStub([
    {
      driverNameOnDoc: TRIENDA_NAME_ON_DOC,
      badgeOrId: FELIX_KFI,
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8.5,
    },
  ]);

  const drivers = [
    // Felix lives on Burnett, not Trienda.
    { kfiId: FELIX_KFI, name: FELIX_NAME, customer: FELIX_CUSTOMER },
    // A real Trienda driver so the AI rosterPool isn't empty (matches
    // production where Trienda has at least one assigned driver).
    { kfiId: "T0001", name: "Real Trienda Driver", customer: TRIENDA },
  ];
  const kfiSet = new Set(drivers.map((d) => d.kfiId));

  const result = await extractImageForKnownCustomer({
    fileName: "trienda-2026-05-10.jpg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    mimeType: "image/jpeg",
    customer: TRIENDA,
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
    idMap: {},
    drivers,
    kfiSet,
  });

  assert.equal(
    result.punches.length,
    0,
    "the colliding row must NOT auto-resolve to Felix",
  );
  assert.equal(
    result.pendingNamedRows?.length,
    1,
    "the colliding row should land in pendingNamedRows for dispatcher review",
  );
  const pending = result.pendingNamedRows![0];
  assert.equal(pending.driverNameOnDoc, TRIENDA_NAME_ON_DOC);
  assert.equal(pending.badgeOrId, FELIX_KFI);
  assert.equal(
    result.unmappedIds.length,
    1,
    "the badge should appear on the unmapped-ids panel",
  );
  assert.equal(result.unmappedIds[0].id, FELIX_KFI);

  __clearAiExtractStubs();
});

test("extractImageForKnownCustomer still resolves when the colliding badge belongs to the uploaded customer's roster", async () => {
  __clearAiExtractStubs();
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Some Trienda Driver",
      badgeOrId: FELIX_KFI,
      date: "2026-05-12",
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8.5,
    },
  ]);

  // Same kfi, but this time the driver IS on Trienda's roster. The
  // guard must NOT block this — it would be a false negative.
  const drivers = [
    { kfiId: FELIX_KFI, name: "Some Trienda Driver", customer: TRIENDA },
  ];
  const kfiSet = new Set(drivers.map((d) => d.kfiId));

  const result = await extractImageForKnownCustomer({
    fileName: "trienda-2026-05-10.jpg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    mimeType: "image/jpeg",
    customer: TRIENDA,
    weekStart: "2026-05-10",
    weekEnd: "2026-05-16",
    idMap: {},
    drivers,
    kfiSet,
  });

  assert.equal(result.punches.length, 1, "in-roster match should resolve");
  assert.equal(result.punches[0].kfiId, FELIX_KFI);
  assert.equal(result.pendingNamedRows?.length ?? 0, 0);

  __clearAiExtractStubs();
});

test("readWithRoles cache path refuses the same collision when badgeGuard is supplied", () => {
  // A minimal Trienda-shaped xlsx where the badge column carries the
  // colliding employee number 2003283 and the name column carries the
  // unrelated nameOnDoc.
  const rows = [
    ["Employee Name", "Employee Number", "Date", "Time In", "Time Out", "Hours"],
    [TRIENDA_NAME_ON_DOC, FELIX_KFI, "2026-05-12", "6:00 AM", "2:30 PM", 8.5],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const roles = { badge: 1, date: 2, timeIn: 3, timeOut: 4, hours: 5, name: 0 };
  const idMap = {};
  const kfiSet = new Set([FELIX_KFI]);
  const driversByKfi = new Map([
    [FELIX_KFI, { name: FELIX_NAME, customer: FELIX_CUSTOMER }],
  ]);

  const guarded = readWithRoles(
    TRIENDA,
    buffer,
    roles,
    kfiSet,
    idMap,
    "2026-05-10",
    "2026-05-16",
    {
      uploadedCustomer: TRIENDA,
      driversByKfi,
      nameAliasMap: new Map(),
    },
  );
  assert.ok(guarded);
  assert.equal(
    guarded.punches.length,
    0,
    "cached recipe must not self-resolve the colliding numeric badge",
  );
  assert.equal(
    guarded.unmappedIds.length,
    1,
    "the badge should surface in the unmapped panel for review",
  );
  assert.equal(guarded.unmappedIds[0].id, FELIX_KFI);
  assert.equal(guarded.unmappedIds[0].sampleName, TRIENDA_NAME_ON_DOC);

  // Sanity check: without the badgeGuard arg the legacy permissive
  // behaviour returns — pinning that the guard is the thing doing the
  // work, not some unrelated change in the reader.
  const unguarded = readWithRoles(
    TRIENDA,
    buffer,
    roles,
    kfiSet,
    idMap,
    "2026-05-10",
    "2026-05-16",
  );
  assert.ok(unguarded);
  assert.equal(unguarded.punches.length, 1);
  assert.equal(unguarded.punches[0].kfiId, FELIX_KFI);
});
