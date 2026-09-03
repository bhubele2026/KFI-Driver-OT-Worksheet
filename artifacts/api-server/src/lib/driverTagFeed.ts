/**
 * The person-grain half of the warehouse feed: which driver carries which tag
 * number.
 *
 * ⭐ WHY IT CANNOT RIDE ON `rows`. The week-grain rows emit nothing for a driver
 * with no punches that week, on purpose — "worked zero hours" and "was not on
 * the roster" are different facts. A tag belongs to the human, not to a week of
 * work, and Housing has to show it for a driver who has not punched in months.
 * Same endpoint, because Easy Auth names ONE path and a new one is an ARM
 * change outside git; different grain, said out loud.
 *
 * ⭐ WHAT THE NUMBER TURNED OUT TO BE (2026-09-03). The team enters these in
 * Connecteam's profile Tags, and every entered value is a Merchants Fleet unit
 * number — the VAN the driver drives, not a personal badge. Two drivers at one
 * customer share 10020926 because they share the van, and Samsara names several
 * of those vehicles after the very driver whose tag matches. This app is only
 * the carrier and keeps calling it what the team calls it; the consumer decides
 * how to say it. Recorded here so nobody re-derives it from the digits.
 *
 * ⚠️ FULL SNAPSHOT. An untagged driver is ABSENT from the array — never present
 * with a null tag. That absence is the ONLY way "the tag was cleared" reaches
 * the warehouse, so the consumer must REPLACE rather than upsert.
 *
 * ⚠️ NOT WINDOWED. `since` and `weeks` do not apply to this array.
 *
 * ⚠️ NO SSNs AND NO RATES, same as the rest of this feed.
 * `driver_payroll_profiles` holds both; this reads the PersonId out of it and
 * nothing else. A join key is not a pay rate — and the shape test pins the
 * field list so that stays true by construction rather than by intention.
 *
 * Pure on purpose: the route tests in this app never import a router (that
 * pulls in the db module, which throws without DATABASE_URL), so the only way
 * this logic is testable is as plain arrays in, plain object out.
 */

export interface DriverTagRow {
  /** This app's own driver key. For tracing a row back by hand — NOT a join key. */
  kfiId: string;
  /** Zenople PersonId — the ONLY key anything downstream is allowed to join on. */
  personId: number | null;
  name: string;
  /** Free-form, at most 32 printable chars. Never null and never "" in this array. */
  tagNumber: string;
  /** When a human last edited it — a tie-break for the consumer, and staleness. */
  tagUpdatedAt: string | null;
}

export interface DriverTagFeed {
  driverTags: DriverTagRow[];
  /** Every driver carrying a tag, INCLUDING the ones no PersonId can reach. */
  taggedDrivers: number;
  /**
   * ⚠️ The coverage hole, travelling WITH the data rather than in a separate
   * dashboard. A tagged driver with no PersonId can never be joined to a van,
   * and a consumer that cannot see how many there are will quietly report a
   * partial answer as a complete one.
   */
  taggedNoPersonId: number;
}

interface DriverLike {
  kfiId: string;
  name: string;
  tagNumber: string | null;
  tagNumberUpdatedAt: Date | null;
}

interface ProfileLike {
  kfiId: string;
  personId: number | null;
}

export function buildDriverTagFeed(
  drivers: ReadonlyArray<DriverLike>,
  profiles: ReadonlyArray<ProfileLike>,
): DriverTagFeed {
  const personBy = new Map<string, number | null>(
    profiles.map((p) => [p.kfiId, p.personId ?? null]),
  );

  const driverTags: DriverTagRow[] = [];
  for (const d of drivers) {
    // Trimmed, because a row written before parseTagNumberInput existed could
    // still hold whitespace — and " " is not a tag anybody can read out loud.
    const tagNumber = (d.tagNumber ?? "").trim();
    if (tagNumber === "") continue;
    driverTags.push({
      kfiId: d.kfiId,
      personId: personBy.get(d.kfiId) ?? null,
      name: d.name,
      tagNumber,
      tagUpdatedAt: d.tagNumberUpdatedAt ? d.tagNumberUpdatedAt.toISOString() : null,
    });
  }

  // By name, so two consecutive pulls diff cleanly for a human reading a log.
  driverTags.sort((a, b) => (a.name === b.name ? a.kfiId.localeCompare(b.kfiId) : a.name.localeCompare(b.name)));

  return {
    driverTags,
    taggedDrivers: driverTags.length,
    taggedNoPersonId: driverTags.filter((r) => r.personId == null).length,
  };
}
