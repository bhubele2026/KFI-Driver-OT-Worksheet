# Zenople export (`Driver_Pay_Units_…`)

The Timesheets page → **Export to Zenople** button downloads the payroll import
workbook that gets loaded into Zenople. It is produced by
`artifacts/api-server/src/lib/zenopleExport.ts` and served by
`GET /api/weeks/:weekStart/zenople-export` (`routes/payroll.ts`).

## What it contains

One row per **(driver × transaction code)**, up to four codes per driver, with
zero-hour buckets dropped:

| Code | Hours from | Meaning |
|------|-----------|---------|
| `RT` | `custRt` | customer-timesheet regular (≤ 40 combined) |
| `OT` | `custOt` | customer-timesheet overtime (> 40 combined) |
| `DriverRT` | `driverRt` | Connecteam driver regular |
| `DriverOT` | `driverOt` | Connecteam driver overtime |

Regular/overtime is the weekly-40 split on **combined** driver + customer time,
computed once in `hoursEngine.computeDriverTotals` — the same number shown on
each driver's summary page. The 17-column header and layout are byte-matched to
the reference file
`attached_assets/Driver_Pay_Units_customer_and_Driver_time_PD_05.15.2026_…xlsx`.

Per-driver identity + rates (SSN, JobId, PersonId, Assignment, 8 pay/bill
rates, the Zenople customer label and the "LASTNAME, FIRST" person label) are
pulled **LIVE from Zenople at export time** (`loadZenopleExportFacts()` in
`lib/zenopleRates.ts`) and resolved against the stored `driver_payroll_profiles`
row by `resolveProfile` (`lib/rateResolution.ts`). Live wins for rates because
Zenople's rates drift week to week and this workbook is imported back into
Zenople; the stored profile is the fallback for an unreachable API or a person
absent from the live data. Identity is the other way round — stored wins unless
`ZENOPLE_LIVE_IDENTITY=1`.

**⚠️ The assignment rate IS the rate.** `AssignmentData.PayRate` / `.BillRate`
for the assignment in force that week, with OT = **1.5 ×** RT. Transaction
actuals are a fallback for an assignment Zenople carries no rate on — never an
override.

> This was inverted until 2026-09-03. OT came from
> `sum(OTPay)/sum(OTPayHours)` over a **year** of TransactionData, which blends
> across every raise a person ever had, and it beat the assignment rate. Baez
> (2003283) exported at OT 32.55 while Zenople had been paying him 32.90 for
> twelve straight periods; Medina (2004792) at 30.27 against a true 31.50.
> Measured against what Zenople actually paid in PPE 2026-08-29: the old rule
> was wrong for **206 of 505 people**, 194 of them low, worst case $4.93/hr.
> The current rule matches 501/505 within 2¢.

Everything resolves **as-of the exported week**, not as-of today:
`pickAssignment` filters to assignments overlapping the week (so an assignment
created after the week closed cannot supply its rate — the Tijerina defect),
and windowed actuals come from the pay period the week fell in.

> ⚠️ Known limit: Zenople edits `PayRate` **in place** on an existing
> assignment row and `AssignmentData` carries no rate history. A back-dated
> re-export of an old week therefore uses today's rate for that assignment.
> Exporting the current week — the actual workflow — is unaffected.

Both the workbook and the driver's **Pay & bill rates** card call
`resolveProfile`, so what the card shows is what the workbook ships. The card
also renders per-rate provenance (`zenople` / `derived` / `saved` / `missing`)
and flags a saved value that Zenople is overriding, because editing such a
field is otherwise a silent no-op.

Export is gated by `computeReadiness`: every driver with hours must be marked
**good** and have the 5 identity fields (checked against the stored profile,
which the boot backfill keeps populated). Rates deliberately do not gate it.

## PPE column — uniform week-end Saturday

Every row stamps the app week's **Saturday** (e.g. week 2026-07-19 → PPE
2026-07-25 → serial 46228). An earlier per-customer Sunday shift
(Adient/DeLallo/Schuette/WB) matched a May reference but the PD 07.24 and
PD 07.31 files both stamp one uniform Saturday — the Sunday rule is retired
(2026-08-05).

## Shift differential — OFF (no customer re-rates)

`SHIFT_DIFF_CUSTOMERS` (`zenopleExport.ts`) is **empty as of 2026-09-03**.
It held **Shuster's Building Components** from 2026-08-05, when the rule was
built to reproduce that month's reference workbook; Tiana reported the export
was "still doing the shift differential for the Shusters drivers" and it was
switched off. Shuster's now exports plain RT/OT like everyone else.

The mechanism below is retained — re-enabling a customer is one line in that
set. `buildZenopleRows` takes the set as an optional third argument so the
behaviour stays under test without pinning a live customer's name.

> ⚠️ Turning a customer on suppresses their RT/OT rows **and** hides their
> hours from the pay-vs-bill tie-out: `payrollTieOuts.ts` excludes both
> ShiftDifferential codes from `REGULAR_PAY_CODES`, `OT_PAY_CODES` and
> `BASE_HOURS_CODES`. Turning Shuster's off means their hours now appear in
> those tie-outs, so tie-out totals for Shuster's weeks change.

Customers in the set get NO RT/OT rows.
Instead the export emits, per driver with `DriverRT` hours `X > 0`:

```
ShiftDifferential     −X   @ RT pay rate   (RT bill rate)
ShiftDifferentialOT   +X   @ OT pay rate   (OT bill rate)
DriverRT               X   @ driver RT rate
DriverOT               …   @ driver OT rate (when present)
```

matching the reference files exactly (Lunar: −7.67@18 / +7.67@27 /
DriverRT 7.67@10 in PD 07.31). No manual post-export step anymore.
