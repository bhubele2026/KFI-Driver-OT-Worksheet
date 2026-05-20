// Connecteam time-clock constants ported from the legacy single-page
// dashboard. The customer payroll-id dictionaries (EMBEDDED_MAPPING,
// USER_ID_ALIASES_LD, IWG_DRIVER_IDS) used to live here too; they were
// lifted into DB tables (Task #287):
//   - badge → kfi mappings: `driver_id_aliases` (admin-managed via
//     /admin/driver-id-aliases, populated by the picker on every upload)
//   - Connecteam userId cross-clock merges: `connecteam_user_aliases`
//     (admin-managed via /admin/connecteam-user-aliases)
//   - per-driver display timezone overrides: `drivers.display_tz`
//     (admin-managed via /admin/timezones)

export const TIME_CLOCKS = [
  14587307, // KFI Staffing
  14672527, // Relocation
  14778394, // Trienda
  16923482, // EST-KFI
  14672533, // Burnett Grantsburg
  14672553, // Adient
  14672594, // Landscape Structures
] as const;

/**
 * Connecteam time-clock IDs whose raw timestamps need a +1h fix so that the
 * displayed wall-clock matches what the driver punched. This was reverse-
 * engineered in the legacy app and is preserved for parity.
 */
export const SHUSTER_CLOCK_IDS = new Set<number>([2005033, 2004992]);
