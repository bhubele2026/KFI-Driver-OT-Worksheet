/**
 * The tile registry — the authorization unit for this app.
 *
 * One source of truth, and it lives on the SERVER. The Financial Dashboard keeps
 * its registry in a package shared with the web app; here the client instead
 * receives the tiles it holds from GET /api/tiles and renders those. Same
 * guarantee (the grid and the owner panel cannot disagree), without adding a
 * workspace package to a Docker build that installs with --frozen-lockfile.
 *
 * `key` is what a grant row stores. Renaming one orphans every grant that names
 * it, so treat these as permanent identifiers, not labels.
 */

export const TILE_GROUPS = ["Payroll", "The week", "Admin"] as const;
export type TileGroup = (typeof TILE_GROUPS)[number];

export interface TileDef {
  key: string;
  group: TileGroup;
  href: string;
  title: string;
  blurb: string;
  /** Bottom call-to-action. Stored sentence-case; CSS uppercases it. */
  source: string;
  /** Also requires users.is_admin, on top of holding the tile. */
  adminOnly?: boolean;
}

export const TILES: TileDef[] = [
  {
    key: "payroll_process",
    group: "Payroll",
    href: "/payroll-process",
    title: "Payroll Process",
    blurb: "The pay-period checklist, live — progress, blockers, and owners at a glance.",
    source: "Run the week",
  },
  {
    key: "payroll_changes",
    group: "Payroll",
    href: "/payroll-process/changes",
    title: "Changes & Deductions",
    blurb: "Every payroll change for the period, staged in processing order with deadlines and sign-off.",
    source: "This payroll",
  },
  {
    key: "payroll_templates",
    group: "Payroll",
    href: "/payroll-process/templates",
    title: "Templates",
    blurb: "Per-customer timesheet templates — prepared, sent, and tracked.",
    source: "Friday",
  },
  {
    key: "payroll_hours",
    group: "Payroll",
    href: "/payroll-process/hours",
    title: "Hours Intake",
    blurb: "Hours received from each customer, verified against time punches.",
    source: "Monday",
  },
  {
    key: "payroll_master",
    group: "Payroll",
    href: "/payroll-process/master",
    title: "Master Import",
    blurb: "The master import — assembled, tied out, and cleared for Zenople.",
    source: "Monday",
  },
  {
    key: "payroll_fringe",
    group: "Payroll",
    href: "/payroll-process/fringe",
    title: "Fringe",
    blurb: "Housing fringe against deductions — balanced to the cent.",
    source: "Tuesday",
  },
  {
    key: "payroll_batch",
    group: "Payroll",
    href: "/payroll-process/batch",
    title: "Payroll Batch",
    blurb: "Batch review — register balance, outliers, and state requirements.",
    source: "Wednesday",
  },
  {
    key: "payroll_taxes",
    group: "Payroll",
    href: "/payroll-process/taxes",
    title: "Taxes / APTM",
    blurb: "Daily tax summary tied to the register, with the filing clock.",
    source: "Wednesday",
  },
  {
    key: "payroll_expert_pay",
    group: "Payroll",
    href: "/payroll-process/expert-pay",
    title: "Expert Pay",
    blurb: "Child-support remittance — exported, totaled, and verified.",
    source: "Thursday",
  },
  {
    key: "payroll_rates",
    group: "Payroll",
    href: "/payroll-process/rates",
    title: "Rates & Terms",
    blurb: "Rate changes, markups, and end-of-assignment updates.",
    source: "Thursday",
  },
  {
    key: "payroll_off_cycle",
    group: "Payroll",
    href: "/payroll-process/off-cycle",
    title: "Off-Cycle",
    blurb: "Advances, voids, and reissues handled outside the weekly run.",
    source: "As needed",
  },
  {
    key: "payroll_holiday",
    group: "Payroll",
    href: "/payroll-process/holiday",
    title: "Holiday Pay",
    blurb: "Holiday pay eligibility, verified against the look-back rules.",
    source: "Per holiday",
  },
  {
    key: "upload",
    group: "The week",
    href: "/upload",
    title: "Driver Upload",
    blurb: "Bring the week in — time punches and customer timesheets.",
    source: "Bring the week in",
  },
  {
    key: "timesheets",
    group: "The week",
    href: "/timesheets",
    title: "Timesheets",
    blurb: "Review hours and overtime, resolve mismatches, and export to payroll.",
    source: "Review & export",
  },
  {
    key: "history",
    group: "The week",
    href: "/history",
    title: "History",
    blurb: "Completed payroll weeks, ready to review or reprint.",
    source: "Past weeks",
  },
];

export const TILE_KEYS: string[] = TILES.map((t) => t.key);

/**
 * Event-only pseudo-tiles. NOT grantable, never in the access panel, and no
 * page of their own in the registry — they exist so the front door and the
 * owner's Settings pages can be click-logged at all. `settings` stopped being
 * a real tile when Settings moved behind the owner's gear (2026-09-01):
 * grants that still name it are inert, by design.
 */
export const PSEUDO_TILE_KEYS = ["home", "settings"] as const;

/** A key the event log accepts: any real tile, or a pseudo-tile. */
export const isEventTileKey = (v: string): boolean =>
  TILE_KEYS.includes(v) || (PSEUDO_TILE_KEYS as readonly string[]).includes(v);

/**
 * Tiles nobody can be granted — the owner holds them by being the owner.
 * Empty today; the mechanism exists so making one owner-only later is a
 * one-line change rather than a new concept.
 */
export const OWNER_ONLY_TILE_KEYS: string[] = [];

/**
 * The Payroll group grant. It is NOT a tile — it has no page and never appears
 * in the nav. Ticking it confers every tile in the Payroll group, including
 * ones added later, which is the whole point: "this person runs payroll" should
 * not need re-granting every time the checklist grows another board.
 *
 * Mirrors the Financial Dashboard's SALES_GROUP_KEY / REP_TILE_KEYS pair.
 */
export const PAYROLL_GROUP_KEY = "payroll_all";

export const PAYROLL_TILE_KEYS: string[] = TILES.filter(
  (t) => t.group === "Payroll",
).map((t) => t.key);

/** Keys a grant row may legally store: every tile, plus the group grants. */
export const GRANTABLE_KEYS: string[] = [...TILE_KEYS, PAYROLL_GROUP_KEY];

/**
 * Stored grant rows → the tiles they actually confer.
 *
 * ⚠️ EVERY read of a person's access must go through this. `tilesForUser`
 * filters unknown keys against TILE_KEYS, and `payroll_all` is deliberately not
 * one — so expanding AFTER that filter would drop the group grant on the floor
 * and silently confer nothing.
 */
export const expandGrants = (stored: string[]): string[] => {
  const out = new Set(stored);
  if (out.has(PAYROLL_GROUP_KEY)) for (const k of PAYROLL_TILE_KEYS) out.add(k);
  return [...out];
};

export const isTileKey = (v: string): boolean => TILE_KEYS.includes(v);

export const tileByKey = (key: string): TileDef | undefined =>
  TILES.find((t) => t.key === key);

/**
 * Which tile a path belongs to, for the client route gate and nav filtering.
 *
 * ⚠️ Longest href wins. The payroll sub-tiles live UNDER the spine's path
 * (`/payroll-process/changes` sits below `/payroll-process`), so a first-match
 * lookup would resolve every one of them to the parent tile and let anyone
 * holding the spine through every child gate. Match the most specific href.
 */
export const tileKeyForPath = (path: string): string | undefined =>
  TILES.filter((t) => path === t.href || path.startsWith(t.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.key;
