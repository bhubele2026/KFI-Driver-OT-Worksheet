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
    blurb: "The 51-step checklist for this pay period, live — what is done, what is blocked, and on whom.",
    source: "Run the week",
  },
  {
    key: "payroll_changes",
    group: "Payroll",
    href: "/payroll-process/changes",
    title: "Changes & Deductions",
    blurb: "Everything from payroll@ that must be keyed before the pay date, as action rows with the last reply's number.",
    source: "This payroll",
  },
  {
    key: "payroll_templates",
    group: "Payroll",
    href: "/payroll-process/templates",
    title: "Templates",
    blurb: "Friday's per-customer timesheet templates — split, send and track.",
    source: "Friday",
  },
  {
    key: "payroll_hours",
    group: "Payroll",
    href: "/payroll-process/hours",
    title: "Hours Intake",
    blurb: "Per-customer board: hours in, punches compared, and each customer's own quirks.",
    source: "Monday",
  },
  {
    key: "payroll_master",
    group: "Payroll",
    href: "/payroll-process/master",
    title: "Master Import",
    blurb: "Assemble the master file, run the tie-outs, and work the no-hours list.",
    source: "Monday",
  },
  {
    key: "payroll_fringe",
    group: "Payroll",
    href: "/payroll-process/fringe",
    title: "Fringe",
    blurb: "Housing Benefit Supplemental against TBD3 deductions — the balance that has to be exact.",
    source: "Tuesday",
  },
  {
    key: "payroll_batch",
    group: "Payroll",
    href: "/payroll-process/batch",
    title: "Payroll Batch",
    blurb: "Register balance, outliers, live checks, MN ESST and Pennsylvania withholding.",
    source: "Wednesday",
  },
  {
    key: "payroll_taxes",
    group: "Payroll",
    href: "/payroll-process/taxes",
    title: "Taxes / APTM",
    blurb: "Daily tax pivot tied to the register, and the upload clock.",
    source: "Wednesday",
  },
  {
    key: "payroll_expert_pay",
    group: "Payroll",
    href: "/payroll-process/expert-pay",
    title: "Expert Pay",
    blurb: "Child support export and totals check. Payment stays manual, and the file stays local.",
    source: "Thursday",
  },
  {
    key: "payroll_rates",
    group: "Payroll",
    href: "/payroll-process/rates",
    title: "Rates & Terms",
    blurb: "Y1 to Y2 markups, terminations, deduction deactivations and pro-rate stops.",
    source: "Thursday",
  },
  {
    key: "payroll_off_cycle",
    group: "Payroll",
    href: "/payroll-process/off-cycle",
    title: "Off-Cycle",
    blurb: "Advances, voids and reissues, with the disbursement channel as a field.",
    source: "As needed",
  },
  {
    key: "payroll_holiday",
    group: "Payroll",
    href: "/payroll-process/holiday",
    title: "Holiday Pay",
    blurb: "26-week eligibility look-back: check dates, 720 worked hours, and an active assignment.",
    source: "Per holiday",
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
