// Constants ported verbatim from the legacy single-page dashboard so that the
// Connecteam ingest and the customer-file parsers produce the same kfi_id
// values they did before.

export const TIME_CLOCKS = [
  14587307, // KFI Staffing
  14672527, // Relocation
  14778394, // Trienda
  16923482, // EST-KFI
  14672533, // Burnett Grantsburg
  14672553, // Adient
  14672594, // Landscape Structures
] as const;

/** Drivers whose wall-clock display tz is Eastern (rest are Central). */
export const IWG_DRIVER_IDS = new Set<string>(["2005056", "2005212"]);

/**
 * Connecteam time-clock IDs whose raw timestamps need a +1h fix so that the
 * displayed wall-clock matches what the driver punched. This was reverse-
 * engineered in the legacy app and is preserved for parity.
 */
export const SHUSTER_CLOCK_IDS = new Set<number>([2005033, 2004992]);

/**
 * Connecteam user IDs that, when seen on a punch, should be remapped to a
 * different KFI driver id (legacy aliases).
 */
export const USER_ID_ALIASES_LD: Record<string, string> = {
  // alias_user_id -> kfi_id
  // (Legacy data preserved exactly — see reference dashboard line 9191.)
};

/**
 * Customer payroll-id → KFI driver id mapping used by the file parsers.
 * Populated as we ingest each customer's roster; safe to extend per-customer.
 */
export const EMBEDDED_MAPPING: Record<string, string> = {
  // Adient TELD codes:
  TELD104651: "2004651",
  TELD103546: "2003546",
  TELD104805: "2004805",
};
