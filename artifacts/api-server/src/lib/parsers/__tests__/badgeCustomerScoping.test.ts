/**
 * Task #360 — Badge → driver resolution must prefer same-customer
 * matches over cross-customer matches.
 *
 * Pre-#360 the AI image path consulted a roster-wide kfi set for
 * the badge-map and badge-self branches of `resolveKfiId`. That
 * meant a badge whose value happened to equal a cross-customer
 * driver's kfi (or that was aliased to one in `driver_id_aliases`)
 * silently resolved across the customer boundary. The Task #359
 * Penda incident was a degenerate case of the same shape: stub
 * drivers whose kfi_ids equaled real Penda badges absorbed Penda
 * hours until the archived filter quarantined them.
 *
 * This suite pins the customer-preferred narrowing applied in
 * `extractImageForKnownCustomer` so a future refactor that drops
 * back to the roster-wide kfi set immediately turns these tests
 * red instead of waiting for a payroll incident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImageForKnownCustomer } from "../imageSupport.js";
import {
  __pushAiExtractStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("badge that maps to a cross-customer driver is rejected when the upload's customer has attached drivers", async () => {
  // Upload is for "Penda Corp". Same-customer driver K-PEN-001
  // exists in the roster. The badge `B100` is aliased (idMap) to
  // K-OTHER-001, attached to a different customer. Expectation:
  // the row does NOT resolve to K-OTHER-001 — it becomes unmapped
  // and would be surfaced to the dispatcher's picker.
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Some Driver",
      badgeOrId: "B100",
      date: "2026-05-10",
      timeIn: "8:00 AM",
      timeOut: "4:30 PM",
      hours: 8.5,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer({
      fileName: "penda.jpg",
      buffer: PNG,
      mimeType: "image/jpeg",
      customer: "Penda Corp",
      weekStart: "2026-05-10",
      weekEnd: "2026-05-16",
      idMap: { B100: "K-OTHER-001" },
      drivers: [
        { kfiId: "K-PEN-001", name: "Penda Person", customer: "Penda Corp" },
        { kfiId: "K-OTHER-001", name: "Other Person", customer: "OtherCo" },
      ],
      kfiSet: new Set(["K-PEN-001", "K-OTHER-001"]),
    });
    assert.equal(
      result.punches.length,
      0,
      "cross-customer aliased badge must not resolve",
    );
    assert.equal(result.unmappedIds.length, 1);
    assert.equal(result.unmappedIds[0].id, "B100");
    assert.equal(result.pendingNamedRows?.length, 1);
  } finally {
    __clearAiExtractStubs();
  }
});

test("badge that self-resolves (kfiSet.has) to a cross-customer driver is rejected when the upload's customer has attached drivers", async () => {
  // Same shape as the Penda incident: a customer file ships a
  // badge whose raw value equals a cross-customer driver's
  // kfi_id. With same-customer drivers in the pool, the row must
  // NOT silently land on the cross-customer driver.
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Some Driver",
      badgeOrId: "K-OTHER-001",
      date: "2026-05-10",
      timeIn: "8:00 AM",
      timeOut: "4:30 PM",
      hours: 8.5,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer({
      fileName: "penda.jpg",
      buffer: PNG,
      mimeType: "image/jpeg",
      customer: "Penda Corp",
      weekStart: "2026-05-10",
      weekEnd: "2026-05-16",
      idMap: {},
      drivers: [
        { kfiId: "K-PEN-001", name: "Penda Person", customer: "Penda Corp" },
        { kfiId: "K-OTHER-001", name: "Other Person", customer: "OtherCo" },
      ],
      kfiSet: new Set(["K-PEN-001", "K-OTHER-001"]),
    });
    assert.equal(result.punches.length, 0);
    assert.equal(result.unmappedIds.length, 1);
    assert.equal(result.unmappedIds[0].id, "K-OTHER-001");
  } finally {
    __clearAiExtractStubs();
  }
});

test("bootstrap fallback: cross-customer badge still resolves when the row's nameOnDoc matches the candidate driver (Task #363 trustworthy-match path)", async () => {
  // Brand-new customer with no `drivers.customer` assignments yet.
  // Under the Task #363 collision guard the badge is still allowed
  // to land cross-customer when the row carries a name that fuzzy-
  // matches the candidate driver — covering the bootstrap scenario
  // where a customer's first upload arrives before any drivers are
  // attached to that customer.
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Roaming Driver",
      badgeOrId: "K-ROAM-001",
      date: "2026-05-10",
      timeIn: "8:00 AM",
      timeOut: "4:30 PM",
      hours: 8.5,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer({
      fileName: "brand-new.jpg",
      buffer: PNG,
      mimeType: "image/jpeg",
      customer: "Brand New Customer",
      weekStart: "2026-05-10",
      weekEnd: "2026-05-16",
      idMap: {},
      drivers: [
        { kfiId: "K-ROAM-001", name: "Roaming Driver", customer: "OtherCo" },
      ],
      kfiSet: new Set(["K-ROAM-001"]),
    });
    assert.equal(result.punches.length, 1);
    assert.equal(result.punches[0].kfiId, "K-ROAM-001");
  } finally {
    __clearAiExtractStubs();
  }
});

test("Penda incident replay: badge matching a same-customer driver resolves to that driver even with a cross-customer collision in the roster", async () => {
  // The exact failure mode that motivated #359/#360. Two drivers
  // share the kfi/badge collision space: K-PEN-001 is the real
  // Penda driver, K-STUB-001 is a stub attached to a different
  // customer. The file ships badge `K-PEN-001`. With
  // customer-preferred narrowing, the same-customer driver wins
  // unambiguously — the stub is simply not in the resolution set.
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Real Penda Driver",
      badgeOrId: "K-PEN-001",
      date: "2026-05-10",
      timeIn: "8:00 AM",
      timeOut: "4:30 PM",
      hours: 8.5,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer({
      fileName: "penda.jpg",
      buffer: PNG,
      mimeType: "image/jpeg",
      customer: "Penda Corp",
      weekStart: "2026-05-10",
      weekEnd: "2026-05-16",
      idMap: {},
      drivers: [
        { kfiId: "K-PEN-001", name: "Real Penda Driver", customer: "Penda Corp" },
        { kfiId: "K-STUB-001", name: "Stub Driver", customer: "E2E Stub" },
      ],
      kfiSet: new Set(["K-PEN-001", "K-STUB-001"]),
    });
    assert.equal(result.punches.length, 1);
    assert.equal(result.punches[0].kfiId, "K-PEN-001");
    assert.equal(result.unmappedIds.length, 0);
  } finally {
    __clearAiExtractStubs();
  }
});
