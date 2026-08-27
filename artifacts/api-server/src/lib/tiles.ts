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
    blurb: "The payroll run, start to finish.",
    source: "Open",
  },
  {
    key: "upload",
    group: "The week",
    href: "/upload",
    title: "Driver Upload",
    blurb: "Refresh Connecteam punches and drop in each customer's timesheet for the week.",
    source: "Bring the week in",
  },
  {
    key: "timesheets",
    group: "The week",
    href: "/timesheets",
    title: "Timesheets",
    blurb: "Review hours and overtime, catch driver-vs-customer mismatches, print and export to Zenople.",
    source: "Review & export",
  },
  {
    key: "history",
    group: "The week",
    href: "/history",
    title: "History",
    blurb: "Open any past payroll week to review or reprint what was already run.",
    source: "Past weeks",
  },
  {
    key: "settings",
    group: "Admin",
    href: "/settings",
    title: "Settings",
    blurb: "Users, customers, driver aliases, clock offsets, timezones, and app configuration.",
    source: "Admin & config",
    adminOnly: true,
  },
];

export const TILE_KEYS: string[] = TILES.map((t) => t.key);

/**
 * Tiles nobody can be granted — the owner holds them by being the owner.
 * Empty today; the mechanism exists so making one owner-only later is a
 * one-line change rather than a new concept.
 */
export const OWNER_ONLY_TILE_KEYS: string[] = [];

export const isTileKey = (v: string): boolean => TILE_KEYS.includes(v);

export const tileByKey = (key: string): TileDef | undefined =>
  TILES.find((t) => t.key === key);

/** Which tile a path belongs to, for the client route gate and nav filtering. */
export const tileKeyForPath = (path: string): string | undefined =>
  TILES.find((t) => path === t.href || path.startsWith(t.href + "/"))?.key;
