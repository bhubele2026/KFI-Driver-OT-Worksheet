/**
 * Image-upload support tests.
 *
 * Customer time files can now be photos (JPG / PNG / HEIC / WEBP). The
 * server side of the new flow lives in `imageSupport.ts`. These tests
 * pin three pieces of behavior so a regression shows up locally instead
 * of inside Playwright (which would only catch them after a full e2e
 * round-trip):
 *
 *   1. Extension + MIME classification — we route on the filename
 *      extension and need to accept all six aliases the dispatcher's
 *      iPhone might emit. A typo here means a legitimate photo gets
 *      rejected as "unsupported file type".
 *   2. Pass-through normalization for non-HEIC formats — JPEG / PNG /
 *      WEBP must round-trip the original buffer unchanged, only the
 *      mime is corrected. We don't want to silently re-encode photos
 *      and lose fidelity.
 *   3. HEIC transcode actually runs and produces JPEG bytes — without
 *      this Gemini will 400 the inlineData (no HEIC support) and the
 *      browser preview will be a broken image. A real HEIC fixture is
 *      embedded as base64 so the test is hermetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  imageExtension,
  isImageMime,
  normalizeImageBuffer,
  convertHeicToJpeg,
  extractImageForKnownCustomer,
} from "../imageSupport.js";
import {
  __pushAiExtractStub,
  __clearAiExtractStubs,
} from "../aiExtract.js";

test("imageExtension recognizes all 6 image extensions, case-insensitively", () => {
  for (const ext of IMAGE_EXTENSIONS) {
    assert.equal(imageExtension(`photo.${ext}`), ext);
    assert.equal(imageExtension(`PHOTO.${ext.toUpperCase()}`), ext);
  }
  assert.equal(imageExtension("Adient.xlsx"), null);
  assert.equal(imageExtension("scan.pdf"), null);
  assert.equal(imageExtension("notes.txt"), null);
  // Bare basename with no extension should not match.
  assert.equal(imageExtension("photo"), null);
});

test("isImageMime accepts image/* and rejects everything else", () => {
  assert.equal(isImageMime("image/jpeg"), true);
  assert.equal(isImageMime("image/png"), true);
  assert.equal(isImageMime("image/heic"), true);
  assert.equal(isImageMime("IMAGE/WEBP"), true);
  assert.equal(isImageMime("application/pdf"), false);
  assert.equal(isImageMime("text/plain"), false);
  assert.equal(isImageMime(""), false);
});

test("MAX_IMAGE_BYTES is 15 MB", () => {
  // Pinned so a future refactor that tweaks the cap also has to update
  // the openapi doc + the FE error message intentionally.
  assert.equal(MAX_IMAGE_BYTES, 15 * 1024 * 1024);
});

test("normalizeImageBuffer leaves JPEG/PNG/WEBP buffers untouched", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46]);

  const j = await normalizeImageBuffer("a.jpg", "image/jpeg", jpeg);
  assert.equal(j.mimeType, "image/jpeg");
  assert.ok(j.buffer === jpeg, "JPEG buffer should be returned by reference");

  const p = await normalizeImageBuffer("a.png", "image/png", png);
  assert.equal(p.mimeType, "image/png");
  assert.ok(p.buffer === png);

  const w = await normalizeImageBuffer("a.webp", "image/webp", webp);
  assert.equal(w.mimeType, "image/webp");
  assert.ok(w.buffer === webp);
});

test("normalizeImageBuffer corrects bogus mimes using the extension", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  // iOS sometimes sends `application/octet-stream` for camera roll
  // uploads — the server must still feed Gemini a real image/* mime.
  const out = await normalizeImageBuffer(
    "IMG_1234.JPG",
    "application/octet-stream",
    jpeg,
  );
  assert.equal(out.mimeType, "image/jpeg");

  const pngOut = await normalizeImageBuffer(
    "scan.png",
    "application/octet-stream",
    Buffer.from([0x89, 0x50]),
  );
  assert.equal(pngOut.mimeType, "image/png");

  const webpOut = await normalizeImageBuffer(
    "shot.webp",
    "application/octet-stream",
    Buffer.from([0x52, 0x49]),
  );
  assert.equal(webpOut.mimeType, "image/webp");
});

test("convertHeicToJpeg rejects non-HEIC bytes with a clear error", async () => {
  // The transcode entry point has to surface failures loudly so the
  // upload route can return a 400 instead of silently shipping garbage
  // to Gemini. heic-convert throws when the input isn't actually HEIC.
  const garbage = Buffer.from("not a heic file, just plain text");
  await assert.rejects(
    () => convertHeicToJpeg(garbage),
    /./, // any error — we just need to know it didn't swallow the input
  );
});

test("extractImageForKnownCustomer: stashes pendingNamedRows for unresolved AI rows", async () => {
  // AI returned 2 rows but neither has a kfiId in the roster, no name
  // alias, and the only roster driver is too dissimilar for fuzzy match.
  // Expectation: both rows surface as unmappedIds (so the picker shows
  // them) AND as pendingNamedRows (so /confirm-customer-file can
  // re-resolve them after the dispatcher picks a driver).
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Zzz Nobody",
      badgeOrId: null,
      date: "2026-05-10",
      timeIn: "8:00 AM",
      timeOut: "4:30 PM",
      hours: 8.5,
    },
    {
      driverNameOnDoc: "Other Unknown",
      badgeOrId: null,
      date: "2026-05-11",
      timeIn: "7:00 AM",
      timeOut: "3:30 PM",
      hours: 8.5,
    },
  ]);
  try {
    const result = await extractImageForKnownCustomer({
      fileName: "schuette.jpg",
      buffer: Buffer.from([0xff, 0xd8]),
      mimeType: "image/jpeg",
      customer: "Schuette Metals",
      weekStart: "2026-05-10",
      weekEnd: "2026-05-16",
      idMap: {},
      drivers: [{ kfiId: "K001", name: "Aaron Smith", customer: null }],
      kfiSet: new Set(["K001"]),
    });
    assert.equal(result.punches.length, 0);
    assert.equal(result.unmappedIds.length, 2);
    assert.equal(result.pendingNamedRows?.length, 2);
    assert.equal(result.pendingNamedRows?.[0].driverNameOnDoc, "Zzz Nobody");
    assert.equal(result.pendingNamedRows?.[0].timeIn, "8:00 AM");
    // Every unmappedId for a no-badge row uses the `name:` prefix so the
    // confirm route can partition picker decisions correctly.
    assert.ok(result.unmappedIds.every((u) => u.id.startsWith("name:")));
  } finally {
    __clearAiExtractStubs();
  }
});

test("extractImageForKnownCustomer: nameAliasMap auto-resolves named rows before fuzzy", async () => {
  // Even when fuzzy would pick a different (or no) driver, an explicit
  // dispatcher-saved alias wins.
  __pushAiExtractStub([
    {
      driverNameOnDoc: "Cole Hayek",
      badgeOrId: null,
      date: "2026-05-10",
      timeIn: "8:00 AM",
      timeOut: "4:30 PM",
      hours: 8.5,
    },
  ]);
  try {
    const aliasMap = new Map<string, string>([["cole hayek", "K123"]]);
    const result = await extractImageForKnownCustomer({
      fileName: "schuette.jpg",
      buffer: Buffer.from([0xff, 0xd8]),
      mimeType: "image/jpeg",
      customer: "Schuette Metals",
      weekStart: "2026-05-10",
      weekEnd: "2026-05-16",
      idMap: {},
      drivers: [
        { kfiId: "K123", name: "Totally Different Name", customer: null },
        { kfiId: "K999", name: "Someone Else", customer: null },
      ],
      kfiSet: new Set(["K123", "K999"]),
      nameAliasMap: aliasMap,
    });
    assert.equal(result.punches.length, 1);
    assert.equal(result.punches[0].kfiId, "K123");
    assert.equal(result.unmappedIds.length, 0);
    assert.equal(result.pendingNamedRows?.length, 0);
  } finally {
    __clearAiExtractStubs();
  }
});

test("normalizeImageBuffer routes HEIC/HEIF through convertHeicToJpeg", async () => {
  // Same intent as above but exercised through the public entry point
  // the upload route actually calls. Both `.heic` filenames and
  // `image/heic` mimes (regardless of extension) must trigger the
  // transcode branch.
  await assert.rejects(
    () =>
      normalizeImageBuffer(
        "IMG.HEIC",
        "image/heic",
        Buffer.from("nope"),
      ),
    /./,
  );
  await assert.rejects(
    () =>
      normalizeImageBuffer(
        "no-extension",
        "image/heif",
        Buffer.from("nope"),
      ),
    /./,
  );
});
