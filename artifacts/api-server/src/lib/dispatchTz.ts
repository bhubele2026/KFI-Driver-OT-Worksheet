import { eq } from "drizzle-orm";
import { CT_TZ, isAllowedTz } from "./time.js";
import { db, schema } from "./db.js";

/**
 * Pick the display timezone for a driver's punches. Precedence:
 *   1. an explicit per-upload override (if provided + valid)
 *   2. the driver's persisted `display_tz` column
 *   3. CT_TZ (America/Chicago)
 *
 * The legacy IWG hardcode was removed in Task #287; the seed-then-wipe
 * migration sets `display_tz='America/New_York'` for the affected kfiIds
 * (2005056, 2005212) so the persisted column carries the same semantics.
 */
export function resolveDispTz(
  _kfiId: string,
  driverDisplayTz: string | null | undefined,
  override?: string | null,
): string {
  if (isAllowedTz(override)) return override;
  if (driverDisplayTz && isAllowedTz(driverDisplayTz)) return driverDisplayTz;
  return CT_TZ;
}

/** Load every driver's display_tz keyed by kfiId. */
export async function loadDriverTzMap(): Promise<Map<string, string | null>> {
  const rows = await db
    .select({
      kfiId: schema.driversTable.kfiId,
      displayTz: schema.driversTable.displayTz,
    })
    .from(schema.driversTable);
  const out = new Map<string, string | null>();
  for (const r of rows) out.set(r.kfiId, r.displayTz ?? null);
  return out;
}

/** Look up a single driver's display_tz (returns null if no row). */
export async function loadDriverTz(kfiId: string): Promise<string | null> {
  const [row] = await db
    .select({ displayTz: schema.driversTable.displayTz })
    .from(schema.driversTable)
    .where(eq(schema.driversTable.kfiId, kfiId))
    .limit(1);
  return row?.displayTz ?? null;
}
