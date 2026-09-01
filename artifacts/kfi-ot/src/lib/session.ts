/**
 * What an expired sign-in looks like, and why it used to read as a broken app.
 *
 * Easy Auth is configured `unauthenticatedClientAction: RedirectToLoginPage`,
 * so a dead cookie answers EVERY request — /api/tiles included — with a 302 to
 * login.microsoftonline.com. A top-level navigation follows that fine (which
 * is why reloading "fixes" it); a fetch() follows it cross-origin, gets no
 * CORS headers back, and the browser reports `TypeError: Failed to fetch`.
 * The SPA never navigates on its own, so it never recovers.
 *
 * The fix (ported from KFI-Housing's session.ts, same incident on the
 * Financial Dashboard estate): every fetch uses `redirect: "manual"`, an
 * opaque-redirect response drives Easy Auth's login endpoint ONCE, and a
 * sessionStorage stamp stops a refused cookie becoming an infinite bounce.
 *
 * ⚠️ Safe only because nothing in this app's API redirects — every route
 * answers JSON. Keep `grep -rn "res.redirect" artifacts/api-server/src` empty.
 */

let recovering = false;

const ATTEMPT_KEY = "kfi-ot.relogin";
/** Long enough to cover an Entra SSO round-trip, short enough that a genuine
 *  expiry hours later still gets a fresh automatic attempt. */
const RETRY_WINDOW_MS = 60_000;

export const SESSION_DEAD_MESSAGE =
  "Your sign-in expired and signing back in didn't take. Reload the page, or sign in again.";

function lastAttempt(): number {
  try {
    return Number(sessionStorage.getItem(ATTEMPT_KEY)) || 0;
  } catch {
    // Private windows throw on access; fall back to the in-memory flag.
    return 0;
  }
}

function stampAttempt(at: number): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, String(at));
  } catch {
    /* see lastAttempt */
  }
}

/** Called on every response that actually arrived, so a later expiry is
 *  treated as fresh rather than as a failed retry. */
export function noteSessionAlive(): void {
  if (recovering) return;
  try {
    if (sessionStorage.getItem(ATTEMPT_KEY)) sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    /* ignore */
  }
}

/** Easy Auth's login entry point, told where to put the user back. */
export function loginUrl(returnTo = window.location.pathname + window.location.search): string {
  return `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(returnTo)}`;
}

/**
 * Send the browser through Entra and back to the board it was on. Returns a
 * promise that never settles — the page is navigating away.
 *
 * ⚠️ The loop guard is not optional: if the sidecar keeps refusing the cookie
 * we would bounce through login.microsoftonline.com forever. After one attempt
 * inside the window we surface a real error instead.
 */
export function recoverSession(): Promise<never> {
  const now = Date.now();
  if (recovering) return new Promise<never>(() => {});
  if (now - lastAttempt() < RETRY_WINDOW_MS) {
    return Promise.reject(new Error(SESSION_DEAD_MESSAGE));
  }
  recovering = true;
  stampAttempt(now);
  window.location.assign(loginUrl());
  return new Promise<never>(() => {});
}

/**
 * fetch with the expired-session handling built in. Use this for every
 * hand-written fetch to our own API. An opaqueredirect means Easy Auth
 * refused the cookie — drive the login instead of surfacing
 * "Failed to fetch" on whichever board was clicked first.
 */
export async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const r = await fetch(input, { credentials: "include", ...init, redirect: "manual" });
  if (r.type === "opaqueredirect" || (r.status === 0 && r.type === "opaque")) {
    return recoverSession();
  }
  noteSessionAlive();
  return r;
}
