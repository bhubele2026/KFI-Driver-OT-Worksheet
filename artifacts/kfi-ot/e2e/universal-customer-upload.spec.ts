/**
 * Regression coverage for "every customer row must accept a file."
 *
 * Before task #232, `/extract-customer-file` rejected any explicit
 * `customer=` value that wasn't in the hardcoded `KNOWN_CUSTOMERS` list
 * with a 400 "Unknown customer "X"." That broke every panel row sourced
 * from the driver roster (Schuette Metals, WB Manufacturing, Shuster's
 * Building Components, Trienda Holdings, zzKFI Internal, …) — the
 * dispatcher could see the row but couldn't upload to it.
 *
 * We don't run the real Gemini extractor in CI (slow + flaky). Instead
 * we lean on the new early inactive-customer guard, which fires AFTER
 * the new permissive `explicitCustomer` parsing but BEFORE the AI call.
 * That gives us a deterministic round trip that exercises the same code
 * path:
 *   1. Mark "Schuette Metals" inactive (a customer that is NOT in
 *      KNOWN_CUSTOMERS).
 *   2. POST /extract-customer-file with `customer=Schuette Metals` and
 *      a tiny xlsx body.
 *   3. Assert the response is the "inactive — reactivate" error, NOT
 *      the legacy "Unknown customer" rejection.
 *
 * A regression that re-adds the allowlist check would short-circuit at
 * step 2 with the old error and this test would fail.
 */
import { test, expect } from "@playwright/test";
import { signInAsDispatcher } from "./_helpers/auth.js";

const WEEK_START = "2026-04-19";
const UNKNOWN_CUSTOMER = "Schuette Metals";

// Smallest possible thing the multer/xlsx classifier will accept — the
// route never actually parses it because the inactive guard fires first.
const TINY_XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP magic

test("extract-customer-file accepts unknown customer names (no allowlist)", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  // Mark the unknown customer inactive so the route's early inactive
  // guard gives us a deterministic, AI-free response.
  const markRes = await page.request.post("/api/customer-active-state", {
    data: { customer: UNKNOWN_CUSTOMER },
  });
  expect(markRes.ok()).toBe(true);

  try {
    const res = await page.request.post(
      `/api/weeks/${WEEK_START}/extract-customer-file`,
      {
        multipart: {
          customer: UNKNOWN_CUSTOMER,
          file: {
            name: "schuette-week.xlsx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: TINY_XLSX,
          },
        },
      },
    );
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error?: string };
    const msg = (body.error ?? "").toLowerCase();
    // Pin the post-fix behavior: the inactive guard wins, NOT the
    // pre-task #232 "Unknown customer" allowlist rejection.
    expect(msg).toContain("inactive");
    expect(msg).not.toContain("unknown customer");
  } finally {
    // Always reactivate so this test doesn't leave dashboard state
    // behind that would shadow Schuette Metals from later specs.
    await page.request.delete(
      `/api/customer-active-state?customer=${encodeURIComponent(UNKNOWN_CUSTOMER)}`,
    );
  }
});
