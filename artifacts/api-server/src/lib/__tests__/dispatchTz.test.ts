import test from "node:test";
import assert from "node:assert/strict";
import { resolveDispTz } from "../dispatchTz.js";
import { CT_TZ } from "../time.js";

const ANY_KFI = "9999999";

test("resolveDispTz: override beats everything when valid", () => {
  assert.equal(
    resolveDispTz(ANY_KFI, "America/Chicago", "America/Denver"),
    "America/Denver",
  );
  assert.equal(
    resolveDispTz(ANY_KFI, "America/New_York", "America/Los_Angeles"),
    "America/Los_Angeles",
  );
});

test("resolveDispTz: invalid override falls through to driver / CT", () => {
  assert.equal(
    resolveDispTz(ANY_KFI, "America/Denver", "Mars/Olympus"),
    "America/Denver",
  );
  assert.equal(resolveDispTz(ANY_KFI, null, "garbage"), CT_TZ);
  assert.equal(resolveDispTz(ANY_KFI, null, ""), CT_TZ);
});

test("resolveDispTz: driver display_tz applies when no upload override", () => {
  assert.equal(resolveDispTz(ANY_KFI, "America/Phoenix"), "America/Phoenix");
  assert.equal(resolveDispTz(ANY_KFI, "America/New_York"), "America/New_York");
});

test("resolveDispTz: defaults to CT when nothing else is set", () => {
  assert.equal(resolveDispTz(ANY_KFI, null), CT_TZ);
  assert.equal(resolveDispTz(ANY_KFI, undefined, null), CT_TZ);
});

test("resolveDispTz: rejects invalid persisted driver tz, falls to CT", () => {
  assert.equal(resolveDispTz(ANY_KFI, "Europe/Paris"), CT_TZ);
});
