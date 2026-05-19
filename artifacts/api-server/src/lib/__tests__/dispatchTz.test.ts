import test from "node:test";
import assert from "node:assert/strict";
import { resolveDispTz } from "../dispatchTz.js";
import { CT_TZ } from "../time.js";
import { IWG_DRIVER_IDS } from "../mappings.js";

const IWG_ID = [...IWG_DRIVER_IDS][0]!;
const NON_IWG = "9999999";

test("resolveDispTz: override beats everything when valid", () => {
  assert.equal(
    resolveDispTz(IWG_ID, "America/Chicago", "America/Denver"),
    "America/Denver",
  );
  assert.equal(
    resolveDispTz(NON_IWG, "America/New_York", "America/Los_Angeles"),
    "America/Los_Angeles",
  );
});

test("resolveDispTz: invalid override falls through to driver/IWG/CT", () => {
  assert.equal(
    resolveDispTz(NON_IWG, "America/Denver", "Mars/Olympus"),
    "America/Denver",
  );
  assert.equal(resolveDispTz(IWG_ID, null, "garbage"), "America/New_York");
  assert.equal(resolveDispTz(NON_IWG, null, ""), CT_TZ);
});

test("resolveDispTz: driver override applies when no upload override", () => {
  assert.equal(resolveDispTz(NON_IWG, "America/Phoenix"), "America/Phoenix");
  // Driver override even wins over the legacy IWG hardcode.
  assert.equal(resolveDispTz(IWG_ID, "America/Denver"), "America/Denver");
});

test("resolveDispTz: legacy IWG hardcode when no override + no driver tz", () => {
  assert.equal(resolveDispTz(IWG_ID, null), "America/New_York");
  assert.equal(resolveDispTz(IWG_ID, undefined), "America/New_York");
});

test("resolveDispTz: defaults to CT for plain drivers", () => {
  assert.equal(resolveDispTz(NON_IWG, null), CT_TZ);
  assert.equal(resolveDispTz(NON_IWG, undefined, null), CT_TZ);
});

test("resolveDispTz: rejects invalid persisted driver tz, falls to IWG/CT", () => {
  // A bogus value persisted in drivers.display_tz must not bypass the
  // ALLOWED_TZS gate — we fall through to the legacy hardcode / CT.
  assert.equal(resolveDispTz(IWG_ID, "Europe/Paris"), "America/New_York");
  assert.equal(resolveDispTz(NON_IWG, "Europe/Paris"), CT_TZ);
});
