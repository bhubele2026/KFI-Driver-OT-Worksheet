// EVERY CLICK. Brad (on the Housing app, and again here 2026-09-01): "make
// sure I am seeing all users clicks like the financial [dashboard]".
//
// Until now the app logged exactly one thing — a press on a home-grid tile —
// so the Activity tab was blind to deep links, the nav bar, and every button
// inside a board. This records what people actually press: the button, the
// row, the tick, with a readable label.
//
// One capture-phase listener, batched. A POST per click would put a request
// on the wire for every mouse-down in the app; the queue flushes every few
// seconds and on pagehide via sendBeacon, so a click that navigates away
// still lands.

interface Click {
  tile: string;
  kind: "click";
  detail: string;
}

const FLUSH_MS = 4000;
/** A safety valve, not a target — a runaway loop must not post ten thousand
 *  rows. A full queue DROPS presses silently, so it is set far above any
 *  human clicking rate. */
const MAX_QUEUE = 200;

let queue: Click[] = [];
let timer: number | undefined;

/**
 * href → tile key, fed from GET /api/tiles (the server registry), so this
 * mapping can never drift from the tiles that actually exist — the drift is
 * exactly how Housing mis-attributed a whole board to `home` for its life.
 */
let pathTiles: Array<{ href: string; key: string }> = [];
export function setPathTiles(v: Array<{ href: string; key: string }>): void {
  pathTiles = [...v].sort((a, b) => b.href.length - a.href.length);
}

/**
 * Which board a path belongs to. Longest registry href wins (the payroll
 * sub-tiles live UNDER the spine's path). `home` and `settings` are
 * pseudo-tiles — not grantable, never in the access panel — so the front
 * door and the owner's settings pages can be logged at all.
 */
export function tileForPath(path: string): string {
  const hit = pathTiles.find((t) => path === t.href || path.startsWith(t.href + "/"));
  if (hit) return hit.key;
  if (path.startsWith("/settings") || path.startsWith("/admin")) return "settings";
  // Legacy worksheet paths still resolve to the timesheets board.
  if (path.startsWith("/weeks") || path.startsWith("/worksheet")) return "timesheets";
  return "home";
}

/**
 * What the user would say they clicked. Never markup, never class names.
 * `title` sits BELOW the visible text (titles are explanations; the button
 * plainly says "Save"), and only the FIRST LINE survives — a full card's text
 * truncates mid-word into nonsense.
 */
function labelFor(el: Element): string {
  const aria = el.getAttribute("aria-label")?.trim();
  const firstLine = ((el as HTMLElement).innerText ?? el.textContent ?? "").split("\n")[0];
  const title = el.getAttribute("title")?.trim();
  const raw = aria || firstLine || title || "";
  return raw
    // Drop leading ornaments (▸ ↻ ✎ ←) so the label starts at the word.
    // `$` survives: plenty of buttons are amounts.
    .replace(/^[^\p{L}\p{N}$]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function endpoint(): string {
  return `${import.meta.env.BASE_URL}api/tile-open`;
}

function appPath(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const p = window.location.pathname;
  return base && p.startsWith(base) ? p.slice(base.length) || "/" : p;
}

function flush(useBeacon = false): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const body = JSON.stringify({ events: batch });
  // sendBeacon survives the page going away — the click that navigated is
  // exactly the one you most want to have recorded.
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon(endpoint(), new Blob([body], { type: "application/json" }));
    return;
  }
  // redirect:"manual" — a dead session must not turn fire-and-forget
  // telemetry into console and Sentry noise.
  void fetch(endpoint(), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    redirect: "manual",
  }).catch(() => {});
}

export function startClickLog(): void {
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as Element | null;
      // The nearest thing a person would call "the thing I clicked".
      const el = target?.closest?.(
        'button, a, [role="button"], select, summary, input[type="checkbox"], label, option, [aria-disabled]',
      );
      if (!el) return;
      const detail = labelFor(el);
      if (!detail) return;
      if (queue.length >= MAX_QUEUE) return;
      queue.push({ tile: tileForPath(appPath()), kind: "click", detail });
      if (timer == null) timer = window.setTimeout(() => flush(), FLUSH_MS);
    },
    true, // capture: a handler that stops propagation must not hide the click
  );

  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
}
