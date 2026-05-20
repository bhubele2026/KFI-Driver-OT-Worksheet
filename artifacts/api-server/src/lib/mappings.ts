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

// Per-clock raw-timestamp offsets (the legacy Shuster +1h fix and any future
// cases) were lifted into the `clock_offsets` table by Task #288 — managed
// from /admin/clock-offsets and loaded once per Connecteam refresh.
