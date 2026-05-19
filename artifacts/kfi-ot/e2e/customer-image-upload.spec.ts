/**
 * End-to-end coverage for the image-upload routing rules.
 *
 * Images of a customer time sheet (JPG / PNG / HEIC / WEBP, max 15 MB)
 * are accepted *only* through the preview-and-confirm endpoints
 * (`/extract-customer-file` for known customers, `/extract-new-customer`
 * for new ones). They must never go through the legacy direct-write
 * `/upload-customer-file` route, because the AI extractor is
 * non-deterministic and we need the dispatcher to eyeball the rows
 * before payroll picks them up.
 *
 * We don't drive the actual Gemini extraction here (real model calls
 * are slow and flaky in CI). Instead we pin the routing + guard
 * behaviors that surround it:
 *
 *   1. Legacy `/upload-customer-file` rejects images with 400 and a
 *      message pointing at the preview flow.
 *   2. `/extract-customer-file` rejects oversized images (>15 MB) with
 *      a clear 400 instead of streaming the whole payload to Gemini.
 *   3. `/extract-new-customer` enforces the same 15 MB cap.
 *
 * If any of these guards regress, a dispatcher could either silently
 * commit garbled punches (case 1) or burn Gemini quota on payloads
 * we'd reject anyway (cases 2 & 3).
 */
import { test, expect } from "@playwright/test";

const WEEK_START = "2026-04-19";

// A tiny but structurally valid 1x1 PNG. The server never decodes it;
// it just needs to look like an image to the extension/mime classifier.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const TINY_PNG = Buffer.from(TINY_PNG_BASE64, "base64");

// 16 MB of zeros — just over the 15 MB cap so the guard fires.
const OVERSIZED_IMAGE = Buffer.alloc(16 * 1024 * 1024, 0);

// The dashboard triggers the dev auth-bypass POST when it first renders;
// the cookie isn't on the request context until that round-trip lands.
// page.goto resolves on "load", which can race the bypass POST, so we
// poll /api/auth/me until it returns 200 before issuing the multipart
// requests below — otherwise the guard tests get a 401 instead of the
// 400/413 we actually want to assert.
async function bootstrapAuth(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect
    .poll(
      async () => {
        const r = await page.request.get("/api/auth/me");
        return r.status();
      },
      { timeout: 20_000 },
    )
    .toBe(200);
}

test("legacy direct-write upload rejects images and points at the preview flow", async ({
  page,
}) => {
  await bootstrapAuth(page);

  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/upload-customer-file`,
    {
      multipart: {
        file: {
          name: "Adient-photo.png",
          mimeType: "image/png",
          buffer: TINY_PNG,
        },
      },
    },
  );
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error?: string };
  // Don't pin exact wording, but the operator needs a clue that the
  // preview/confirm flow is the right way to send a photo.
  expect((body.error ?? "").toLowerCase()).toMatch(/preview|extract|image/);
});

test("extract-customer-file rejects images over the 15 MB cap", async ({
  page,
}) => {
  await bootstrapAuth(page);

  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-customer-file`,
    {
      multipart: {
        file: {
          name: "huge.jpg",
          mimeType: "image/jpeg",
          buffer: OVERSIZED_IMAGE,
        },
      },
    },
  );
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error?: string };
  expect((body.error ?? "").toLowerCase()).toMatch(/15|mb|large|size/);
});

test("extract-new-customer rejects images over the 15 MB cap", async ({
  page,
}) => {
  await bootstrapAuth(page);

  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/extract-new-customer`,
    {
      multipart: {
        file: {
          name: "huge.heic",
          mimeType: "image/heic",
          buffer: OVERSIZED_IMAGE,
        },
        customer: "Hypothetical Customer",
      },
    },
  );
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error?: string };
  expect((body.error ?? "").toLowerCase()).toMatch(/15|mb|large|size/);
});
