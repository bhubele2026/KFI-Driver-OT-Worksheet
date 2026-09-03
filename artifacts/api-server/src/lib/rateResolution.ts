/**
 * ONE place that answers "what rate will this driver actually export at".
 *
 * Before this existed the driver card and the Zenople workbook were two code
 * paths that never met: the card rendered the stored `driver_payroll_profiles`
 * row verbatim while the export merged live Zenople over it. They disagreed
 * silently and permanently — the boot backfill never overwrites a non-null
 * column, so once a stored rate was written it could not self-correct, while
 * the export kept tracking Zenople. Tiana caught it on 2026-09-03: Baez
 * exported at OT 32.55 while his card said 32.90 (Zenople had been paying
 * 32.90 for twelve periods; the card was right and the workbook was wrong).
 *
 * Both surfaces now call `resolveProfile`. If they ever disagree again it is
 * one function's fault, not a design property.
 */
import {
  mergeProfileWithLive,
  type ZenopleProfile,
  type ZenopleLiveOverlay,
} from "./zenopleExport.js";
import type { RateSource } from "./zenopleRates.js";

export const RATE_FIELDS = [
  "rtPayRate",
  "rtBillRate",
  "otPayRate",
  "otBillRate",
  "driverRtPayRate",
  "driverRtBillRate",
  "driverOtPayRate",
  "driverOtBillRate",
] as const;

export type RateField = (typeof RATE_FIELDS)[number];

/**
 * What the card puts next to a number.
 *  - `zenople` — read from Zenople (the assignment, or that week's actuals)
 *  - `derived` — computed as 1.5 × the RT rate
 *  - `saved`   — Zenople had nothing, so the hand-entered value is in force
 *  - `missing` — nobody has a value; the workbook will write 0
 */
export type RateProvenance = "zenople" | "derived" | "saved" | "missing";

export interface ResolvedProfile {
  /** Exactly what `buildZenopleRows` will rate the workbook at. */
  effective: ZenopleProfile;
  /** The saved DB row, untouched — this is what the Edit form must show. */
  stored: ZenopleProfile;
  provenance: Record<RateField, RateProvenance>;
}

const sourceToProvenance = (s: RateSource | undefined): RateProvenance =>
  s === "derived" ? "derived" : "zenople";

export function resolveProfile(
  stored: ZenopleProfile,
  live: (ZenopleLiveOverlay & { sources?: Record<string, RateSource> }) | null | undefined,
  opts: { liveIdentity?: boolean } = {},
): ResolvedProfile {
  const effective = mergeProfileWithLive(stored, live, opts);
  const provenance = {} as Record<RateField, RateProvenance>;
  for (const field of RATE_FIELDS) {
    // Mirrors `mergeProfileWithLive`'s `live.X ?? stored.X` exactly — read it
    // as "who supplied the number that is actually in `effective`".
    const fromLive = live?.[field] ?? null;
    if (fromLive != null) provenance[field] = sourceToProvenance(live?.sources?.[field]);
    else if (stored[field] != null) provenance[field] = "saved";
    else provenance[field] = "missing";
  }
  return { effective, stored, provenance };
}

/**
 * Fields where a dispatcher's saved value is being ignored because Zenople
 * supplied one. Editing these on the card is a silent no-op, so the card says
 * so rather than letting someone "fix" a rate that will never be used.
 */
export function overriddenRateFields(resolved: ResolvedProfile): RateField[] {
  return RATE_FIELDS.filter((f) => {
    if (resolved.provenance[f] === "saved" || resolved.provenance[f] === "missing") return false;
    const saved = resolved.stored[f];
    return saved != null && Number(saved) !== Number(resolved.effective[f]);
  });
}
