/**
 * A customer-file row that carries a valid Hours value but blank or
 * unparseable clock in/out times must NOT be dropped — the real Penda
 * "Choncoa, Ashley M" rows arrived with 12.35h and empty in/out and were
 * silently discarded as "unparseable in/out time or hours <= 0". The
 * extractor now synthesizes self-consistent nominal times from the hours so
 * the punch survives and reconciles by total hours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImageForKnownCustomer } from "../imageSupport.js";
import {
  __pushAiExtractStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const driverArgs = {
  fileName: "penda.jpg",
  buffer: PNG,
  mimeType: "image/jpeg",
  customer: "Penda Corp",
  weekStart: "2026-05-10",
  weekEnd: "2026-05-16",
  idMap: {},
  drivers: [
    { kfiId: "2005310", name: "Ashley Choncoa", customer: "Penda Corp" },
  ],
  kfiSet: new Set(["2005310"]),
};

test("row with valid hours but blank in/out times is kept, not dropped", async () => {
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Choncoa, Ashley M",
      badgeOrId: "2003274",
      date: "2026-05-10",
      timeIn: "",
      timeOut: "",
      hours: 12.35,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer(driverArgs);
    assert.equal(result.punches.length, 1, "hours-only row must survive");
    assert.equal(result.punches[0].kfiId, "2005310");
    assert.equal(result.punches[0].hours, 12.35);
  } finally {
    __clearAiExtractStubs();
  }
});

test("hours supplied as a numeric string is accepted", async () => {
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Choncoa, Ashley M",
      badgeOrId: "2003274",
      date: "2026-05-10",
      timeIn: "",
      timeOut: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hours: "12.35" as any,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer(driverArgs);
    assert.equal(result.punches.length, 1);
    assert.equal(result.punches[0].hours, 12.35);
  } finally {
    __clearAiExtractStubs();
  }
});

test("full ISO datetime in the time columns parses to real hours", async () => {
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Choncoa, Ashley M",
      badgeOrId: "2003274",
      date: "2026-05-10",
      timeIn: "2026-05-10 05:40:00",
      timeOut: "2026-05-10 18:01:00",
      hours: 0,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer(driverArgs);
    assert.equal(result.punches.length, 1);
    // 05:40 → 18:01 = 12h21m = 12.35h
    assert.equal(result.punches[0].hours, 12.35);
  } finally {
    __clearAiExtractStubs();
  }
});
