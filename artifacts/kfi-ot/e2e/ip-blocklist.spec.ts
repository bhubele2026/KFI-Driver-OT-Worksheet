/**
 * End-to-end coverage for the IP blocklist admin flow on the
 * /admin/users page (artifacts/kfi-ot/src/pages/admin-users.tsx),
 * backed by `lib/ipBlocklist.ts` on the server.
 *
 * The "Block IP" button only appears in the Recent lockouts table,
 * which is fed by `rate_limit_events` rows whose key starts with
 * `ip:`. The test seeds one such row for an arbitrary, documentation-
 * range IP (RFC 5737 TEST-NET-3, 203.0.113.42) so the dispatcher's
 * own real client IP is never touched.
 *
 * Verifies:
 *   - The seeded IP shows a "Block IP" button in Recent lockouts.
 *   - Clicking it (accepting the reason prompt) adds the IP to the
 *     blocklist table and the lockout row flips to a "Blocked" badge.
 *   - A follow-up request from that IP is rejected with HTTP 403 by
 *     the ipBlocklistMiddleware (verified by hitting the API server
 *     directly with a forged X-Forwarded-For header — the public
 *     reverse proxy rewrites client-IP headers, so this verification
 *     intentionally bypasses it).
 *   - Clicking "Unblock" on the blocklist row removes the entry.
 *   - After unblock, the same IP can hit the API again with 200.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsDispatcher } from "./_helpers/auth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the ip-blocklist e2e test.",
  );
}

// The reverse proxy at $KFI_E2E_BASE_URL strips/replaces client-IP
// headers, so we hit the API server directly to forge a request from
// the blocked IP. Override with KFI_E2E_API_DIRECT_URL when the API
// listens elsewhere (CI, docker, etc).
const API_DIRECT_URL =
  process.env.KFI_E2E_API_DIRECT_URL ?? "http://localhost:8080";

const pool = new Pool({ connectionString: DATABASE_URL });

const TEST_IP = "203.0.113.42"; // RFC 5737 TEST-NET-3, never a real client
const BUCKET_NAME = `e2e-blocklist-${Date.now().toString(36)}`;
const BUCKET_KEY = `ip:${TEST_IP}`;

async function seedLockoutEvent(): Promise<void> {
  await pool.query(
    `INSERT INTO rate_limit_events (name, key, blocked_at, expired_at)
     VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour')`,
    [BUCKET_NAME, BUCKET_KEY],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM rate_limit_events WHERE name = $1`, [
    BUCKET_NAME,
  ]);
  await pool.query(`DELETE FROM ip_blocklist WHERE ip = $1`, [TEST_IP]);
}

test.beforeAll(async () => {
  await cleanup(); // defensive — ignore prior partial runs
  await seedLockoutEvent();
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("admin can block an IP, the API rejects it with 403, and admin can unblock", async ({
  page,
  request,
}) => {
  // 1. Sign in via the dev auth bypass.
  await signInAsDispatcher(page);

  // 2. Navigate to the admin users page and wait for the Security card to load.
  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "Admin · Users" }),
  ).toBeVisible();
  await expect(page.getByText("Security activity")).toBeVisible();

  // The Recent lockouts row holds the Block IP button. Locate the row by
  // its monospace key cell so we don't collide with any other test data.
  const lockoutRow = page.locator("tr", { hasText: BUCKET_KEY });
  await expect(lockoutRow).toBeVisible();
  const blockBtn = lockoutRow.getByRole("button", { name: /Block IP/ });
  await expect(blockBtn).toBeVisible();

  // 3. Click Block IP, which opens the shadcn dialog with two fields
  //    (target IP/CIDR pre-filled, optional reason). Fill the reason
  //    and submit.
  await blockBtn.click();
  const blockDialogEl = page.getByRole("dialog", {
    name: /Block IP from the API/,
  });
  await expect(blockDialogEl).toBeVisible();
  const ipField = blockDialogEl.getByLabel(/IP or CIDR/i);
  await expect(ipField).toHaveValue(TEST_IP);
  await blockDialogEl.getByLabel(/Reason/i).fill("e2e test block");
  await blockDialogEl.getByRole("button", { name: /^Block$/ }).click();
  await expect(blockDialogEl).toBeHidden();

  // 4. The IP should now appear in the IP blocklist table, and the
  //    lockout row should flip to a "Blocked" badge.
  const blocklistRow = page.locator("tr", { hasText: TEST_IP }).filter({
    hasText: "e2e test block",
  });
  await expect(blocklistRow).toBeVisible();
  await expect(lockoutRow.getByText("Blocked", { exact: true })).toBeVisible();

  // 5. The middleware should now 403 a request from that IP. Hit the API
  //    server directly with a forged X-Forwarded-For — the public proxy
  //    overwrites client-IP headers so this verification has to bypass it.
  await expect
    .poll(
      async () => {
        const resp = await request.get(`${API_DIRECT_URL}/api/healthz`, {
          headers: { "X-Forwarded-For": TEST_IP },
        });
        return resp.status();
      },
      { timeout: 5_000, message: "expected blocklist middleware to 403" },
    )
    .toBe(403);

  // Sanity: an unrelated IP is still allowed through.
  const okResp = await request.get(`${API_DIRECT_URL}/api/healthz`);
  expect(okResp.status()).toBe(200);

  // 6. Click Unblock on the blocklist row.
  const unblockBtn = blocklistRow.getByRole("button", { name: /Unblock/ });
  await unblockBtn.click();
  await expect(blocklistRow).toHaveCount(0);

  // 7. After unblock, the same forged-IP request should succeed again.
  await expect
    .poll(
      async () => {
        const resp = await request.get(`${API_DIRECT_URL}/api/healthz`, {
          headers: { "X-Forwarded-For": TEST_IP },
        });
        return resp.status();
      },
      { timeout: 5_000, message: "expected unblock to restore access" },
    )
    .toBe(200);
});
