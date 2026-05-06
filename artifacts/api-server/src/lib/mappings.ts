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
 * different KFI driver id (legacy aliases). Drivers on multiple clocks have
 * different userIds per clock, so the alias maps the secondary userId back
 * to the primary KFI id.
 *
 * Source of truth: legacy dashboard (USER_ID_ALIASES_LD, line 9191).
 */
export const USER_ID_ALIASES_LD: Record<string, string> = {
  // alias_user_id -> kfi_id
  "13213413": "2004805", // Jonathan Sepulveda — Relocation clock userId
  "13441325": "2004589", // Luis Ruiz
};

/**
 * Customer payroll-id → KFI driver id mapping used by the file parsers.
 * Source of truth: legacy dashboard (EMBEDDED_MAPPING, line 8105). To add a
 * new customer, just append its payroll-id → kfi-id pairs here — no other
 * code changes are required.
 */
export const EMBEDDED_MAPPING: Record<string, string> = {
  // Generic worksheet IDs (Penda, Trienda, Greystone, Burnett, LSI, Zenople, etc.)
  "692": "2002909",
  "74490508": "2003283",
  "74490576": "2004738",
  "94192369": "2004704",
  "11459312": "2004743",
  "72737390": "2003681",
  "2003141": "2004651",
  "2003056": "2003546",
  "2002941": "2004148",
  "2003037": "2004393",
  "2004490": "2004490",
  "23870385": "2004786",
  "2003199": "2004805",
  "74490600": "2004792",
  "2003210": "2004589",
  "78772815": "2004872",
  "74490605": "2003196",

  // LSI uses an "N" suffix on the same worksheet IDs:
  "72737390N": "2003681",
  "23870385N": "2004786",
  "78772815N": "2004872",
  "75210818N": "2005166",
  "75210818": "2005166",

  // Burnett Grantsburg additions:
  "74490612": "2005207",

  // Adient TELD IDs (parser keeps the TELD prefix):
  TELD692: "2002909",
  TELD104651: "2004651",
  TELD103546: "2003546",
  TELD104805: "2004805",

  // IWG employee IDs:
  "104651": "2005056",

  // DeLallo badge IDs:
  "3619": "2005003",

  // WB Manufacturing — Jesus Lira (manual entry only for now):
  F1SK6593U: "2005037",
};
