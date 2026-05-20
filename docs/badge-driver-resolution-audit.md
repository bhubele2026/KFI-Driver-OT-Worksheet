# Badge → Driver resolution audit (Task #360)

Audit of every code path that maps a raw identifier from an inbound data
source (Connecteam ctUserId, customer-file badge, AI-extracted badge or
name) to a `drivers.kfi_id` for use in `punches`. The goal is payroll
integrity: every resolved kfi must point at the actual driver whose
hours we're recording, and the same input must always resolve to the
same driver across paths.

Follows the Task #359 prod incident in which two archived stub drivers
seeded by an e2e run were resolving real Penda badges (`2001117`,
`2001148`) — they shared the same numeric kfi as the legitimate Penda
drivers, but were flagged `is_archived = true`. The selector at the
extract route had no archived guard, so the badge-self-mapping branch
(`kfiSet.has(badge)`) silently routed Penda hours to the stub rows.
Task #359 quarantined the stub data and added the archived filter to
the extract route; Task #360 extends that audit across every resolver
path and closes the remaining cross-customer hole.

## Resolver inventory

### 1. Connecteam → kfi (`artifacts/api-server/src/lib/connecteam.ts`)

Used by `POST /weeks/:weekStart/refresh-connecteam`. Each Connecteam
shift carries `ctUserId`; the route hands `fetchPunchesForWeek` a
`ctUserIdToKfi` map built from `fetchAllUsers()` plus a
`connecteam_user_aliases` overlay (db-managed alias table, single source
of truth since Task #287).

- Lookup is **keyed by `ctUserId`**, not by badge. There is no fuzzy
  fallback. A ctUserId with no mapping becomes an `unresolved` row in
  the response and never produces a punch.
- Pool builders (`fetchAllUsers()`, `connecteam_user_aliases`) include
  archived drivers by design — Connecteam itself stops emitting shifts
  for terminated workers, so the archived map entry is dormant unless
  the same physical person is re-hired. Not a payroll-integrity risk
  for the badge-resolution surface.

### 2. AI image / generic AI extract — `extractImageForKnownCustomer`

`artifacts/api-server/src/lib/parsers/imageSupport.ts:resolveKfiId`.
Called from the per-customer extract route after the AI returns a row
shape (`driverNameOnDoc`, `badgeOrId`, `resolvedKfiId`). Resolution
ladder (in order):

1. **Badge mapping** via `idMap` (`driver_id_aliases` overlay +
   embedded mapping), case-insensitive. Wins over the AI hint — this is
   the "badge-disagree guard" pinned by `aiRosterResolution.test.ts`.
2. **Self-mapped badge**: `kfiSet.has(badge)` so customer files that
   ship driver kfi_ids directly in the badge column don't need a dummy
   alias per driver.
3. **AI `resolvedKfiId`** hint — only accepted when the model's pick is
   both in the active kfi set *and* in the customer-preferred roster
   pool we sent to the prompt. Anything else is treated as a
   hallucination.
4. **Saved per-customer name alias** (`customer_name_aliases`) —
   dispatcher-vouched pairing from prior uploads.
5. **Fuzzy match** against the customer-preferred pool with confidence
   ≥ 0.85. Anything weaker becomes an unmapped row.

Pool construction (`extractImageForKnownCustomer`):

- `drivers` is the route-supplied list, filtered to `is_archived = false`
  at the call site (Task #359).
- `preferredDrivers` = drivers whose `customer` equals the upload's
  customer.
- `rosterPool = preferredDrivers.length > 0 ? preferredDrivers : drivers`
  — i.e. when the customer has *any* attached drivers we narrow the
  pool to them; otherwise (bootstrap case for a brand-new customer) we
  fall back to the full active roster.
- `fuzzyPool = rosterPool` — the fuzzy and name-alias ladders only see
  the customer-preferred pool.
- **Task #360:** `poolKfiSet = new Set(fuzzyPool.map(d => d.kfiId))`
  is now passed into `resolveKfiId` as the badge-resolution set, in
  place of the roster-wide `kfiSet`. This closes the cross-customer
  hole on branches (1) and (2): a badge that maps (or self-resolves)
  to a driver attached to a *different* customer is rejected, the row
  becomes unmapped, and the picker prompts the dispatcher instead of
  silently attributing punches.

### 3. Cache path — `readWithRoles` / `readPdfWithRoles`

`artifacts/api-server/src/lib/parsers/genericRoleReader.ts`. Runs when
`customer_column_schemas` has a row for the file's
`customer + headerSignature`. No AI call; a deterministic role-based
walker emits rows from cached `(badge, date, timeIn, timeOut, hours[,
name])` column indices. Resolution is **badge-only**:

1. `idMap[rawBadge]` and that kfi must be in the badge-resolution set.
2. Else `kfiSet.has(rawBadge)` self-mapping.

No name alias, no fuzzy, no AI hint — those branches would all require
re-extraction and the cache is the fast path. Pool comes from the
route caller in `weeks.ts::/weeks/:weekStart/extract-customer-file`:

- `kfiSet` is built from drivers filtered to `is_archived = false`
  (Task #359).
- **Task #360:** the route now narrows to a same-customer
  `cacheKfiSet` before calling `readWithRoles` / `readPdfWithRoles`,
  mirroring the AI-path narrowing. Falls back to the full
  archived-filtered roster when the customer has no attached drivers
  yet.

### 4. Confirm-side re-resolution — `/confirm-customer-file`

`artifacts/api-server/src/routes/weeks.ts` (~line 2660). When the
dispatcher confirms a preview, any `pendingNamedRows` that gained a
driver via the dispatcher's just-saved aliases get re-resolved inside
the same transaction (so newly written `driver_id_aliases` and
`customer_name_aliases` are visible). Ladder is badge-alias → badge
self → name-alias, no fuzzy retry. Pool:

- `drivers` filtered to `is_archived = false` (Task #359).
- **Task #360:** narrow to `pendingKfiSet` (same-customer pool, falling
  back to the full archived-filtered roster).

### 5. AI extract for a new customer — `/extract-new-customer`

`artifacts/api-server/src/routes/weeks.ts` (~line 3705). Same pool
construction as `extractImageForKnownCustomer` (customer-preferred
when any attached drivers exist, else full archived-filtered roster).
The downstream `/confirm-new-customer` route trusts the picker-supplied
`mapping[name] → kfiId`. Server-side validation that the picked kfi is
active/in-pool is left to the FE picker, which is fed the same
archived-filtered active roster from `/admin/users` and the
customer-scoped extract response. (Out of scope for #360; tracked
separately if a hardening pass is desired.)

### 6. Driver-id aliases CRUD (`/admin/driver-id-aliases`)

Admin-only. CRUD against `driver_id_aliases`. The alias row carries a
`customer` audit column but the resolver lookups above are **roster-wide
by external_id** — the `(lower(external_id))` unique index means one
badge maps to exactly one kfi globally. Same-customer narrowing is
applied in the resolvers, not in the alias table.

## Sources of `is_archived = false` enforcement

Every `drivers` select that feeds a resolver pool now filters
`is_archived = false`:

| Route / call site                                              | Line(s) |
| -------------------------------------------------------------- | ------- |
| `/weeks/:weekStart/extract-customer-file` — `drivers`          | 1609    |
| `/weeks/:weekStart/extract-customer-file` — cache `cacheKfiSet`| 1790–1795 (Task #360) |
| `/weeks/:weekStart/confirm-customer-file` — `drivers`          | 2296    |
| `/weeks/:weekStart/confirm-customer-file` — `pendingKfiSet`    | 2682–2687 (Task #360) |
| `/weeks/:weekStart/extract-new-customer` — `rosterDrivers`     | 3811    |
| `/weeks/:weekStart/extract-new-customer` — `drivers` (alias)   | 3955    |
| `/admin/driver-id-aliases` (list / join)                       | 4508, 4796 |
| `/admin/connecteam-user-aliases` (list / join)                 | 5031    |

## Cross-customer preference

Pre-Task #360, only the fuzzy and name-alias branches were
customer-preferred. Badge-map (`idMap`) and badge-self (`kfiSet.has`)
branches consulted the roster-wide kfi set, so a badge that happened
to equal a cross-customer driver's kfi (or that was aliased to one)
would silently resolve across customer boundaries. Task #360 narrows
the badge-resolution set to the customer-preferred pool when any
attached drivers exist, in three places:

- `extractImageForKnownCustomer` (AI path).
- Cache call site in `/extract-customer-file`.
- `pending` re-resolution in `/confirm-customer-file`.

The fallback (full archived-filtered roster) only fires when the
customer has zero attached drivers — i.e. a brand-new customer whose
first upload pre-dates any `drivers.customer` assignment. In that
state there is no same-customer signal to prefer; behavior is
unchanged from pre-#360.

## Quick reference

- **Leading-zero handling on badges.** No normalization is applied
  anywhere on the resolver surface. `idMap` keys are looked up as-is,
  with case-insensitive fallback only (`idMap[badge]`,
  `idMap[badge.toLowerCase()]`, `idMap[badge.toUpperCase()]`). Whitespace
  is trimmed; leading zeros are preserved. The AI prompt is also told
  not to strip leading zeros. This is deliberate — customer files
  occasionally ship a numeric-looking badge whose canonical form
  *includes* leading zeros (e.g. `001148` is a distinct id from
  `1148`), and silently stripping would collide them.
- **`drivers.kfi_id` uniqueness.** `drivers.kfi_id` is the primary key
  of the `drivers` table (`lib/db/src/schema/drivers.ts`) so uniqueness
  is enforced at the database level, globally and at write time. The
  `driver_id_aliases` table additionally enforces a case-insensitive
  unique index on `lower(external_id)` so a single badge can never
  alias to two different kfis.

## Out-of-scope follow-ups

- **`/confirm-new-customer` server-side roster validation.** The
  route trusts the picker-supplied `mapping[name] → kfiId` and does
  not verify the kfi is active or attached to this customer. The FE
  picker is fed the right pool, but a forged request body could
  submit any kfi. Low likelihood; not blocking payroll integrity for
  the current threat model.
- **Cache path: per-driver-id alias customer scoping.** The
  `driver_id_aliases` table has a `customer` audit column but the
  lookup index is `lower(external_id)` (roster-wide). Same-customer
  preference is enforced at the resolver, not the lookup. Promoting
  the alias customer column to a real scoping key would require
  schema and migration work.
- **Connecteam ctUserId → kfi: archived-driver dormant entries.**
  `fetchAllUsers()` includes archived drivers. Harmless today because
  Connecteam stops emitting shifts for terminated workers; a rehire
  scenario could reactivate a dormant mapping. Tracked as a watch
  item, not a fix.

## Regression coverage

`artifacts/api-server/src/lib/parsers/__tests__/badgeCustomerScoping.test.ts`
pins the Task #360 behavior end-to-end against `extractImageForKnownCustomer`:

- A badge that maps (via `idMap`) to a cross-customer driver does NOT
  resolve when the upload's customer has same-customer drivers in the
  pool — the row becomes unmapped and the picker would be prompted.
- A badge that self-resolves (`kfiSet.has(badge)`) to a cross-customer
  driver is likewise rejected.
- When the upload's customer has zero attached drivers in the pool,
  the cross-customer fallback still resolves (bootstrap behavior).
- The Penda incident replay: a stub driver kfi that collides with a
  legitimate same-customer driver's badge resolves to the legitimate
  driver, not the stub.
