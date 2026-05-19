import type { Page } from "@playwright/test";

/**
 * Establish an authenticated session for the e2e dispatcher tests.
 *
 * The old pattern — `page.goto("/")` followed by
 * `page.waitForLoadState("networkidle")` — relied on the React `AuthGate`
 * firing its dev-bypass POST during the first render. That was fragile:
 *  - `networkidle` waits for 500ms of zero in-flight requests, which races
 *    against the long-lived `/api/events` SSE on the dashboard. The webdriver
 *    guard in `src/lib/realtime.ts` mostly tames it, but unrelated polling
 *    (admin pages, language detection, query refetches) can still keep the
 *    connection "busy" long enough to time out at 20s.
 *  - When the subsequent `page.goto(target)` raced ahead of the bypass POST
 *    settling, the next page would briefly see `user=null` and redirect to
 *    `/login`, causing flaky "heading not found" failures.
 *
 * This helper sidesteps both problems by hitting `/api/auth/dev-bypass`
 * directly through the browser context's request fixture (which shares
 * cookies with `page`), then issuing a single `commit` navigation that does
 * not wait for `load`/`networkidle` at all. Callers should follow up with an
 * explicit DOM assertion for the screen they care about.
 */
export async function signInAsDispatcher(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/dev-bypass");
  if (!res.ok()) {
    throw new Error(
      `dev-bypass failed: ${res.status()} ${await res.text().catch(() => "")}`,
    );
  }
}

/**
 * Convenience: sign in, then navigate to `path` without waiting for the
 * realtime SSE to settle. The caller is expected to follow up with an
 * explicit DOM expectation (a heading, a row, a test-id) — that is the
 * reliable readiness signal.
 */
export async function signInAndGoto(page: Page, path: string): Promise<void> {
  await signInAsDispatcher(page);
  await page.goto(path, { waitUntil: "commit" });
}
