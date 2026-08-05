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
`lib/zenopleRates.ts` — AssignmentData for RT pay/bill + ids, recent
TransactionData for effective OT rates) and merged field-by-field over the
stored `driver_payroll_profiles` row (`mergeProfileWithLive`). Live wins
because Zenople's rates, bill rates, JobId and AssignmentId drift week to
week (verified against the PD 07.24 vs PD 07.31 reference files) and this
workbook is imported back into Zenople. The stored profile is the fallback —
used when the Zenople API is unreachable/unconfigured or the person isn't in
the live data. Export is gated by `computeReadiness`: every driver with hours
must be marked **good** and have the 5 identity fields (checked against the
stored profile, which the boot backfill keeps populated).

## PPE column — uniform week-end Saturday

Every row stamps the app week's **Saturday** (e.g. week 2026-07-19 → PPE
2026-07-25 → serial 46228). An earlier per-customer Sunday shift
(Adient/DeLallo/Schuette/WB) matched a May reference but the PD 07.24 and
PD 07.31 files both stamp one uniform Saturday — the Sunday rule is retired
(2026-08-05).

## Shift differential — AUTOMATED for Shuster's

Customers in `SHIFT_DIFF_CUSTOMERS` (`zenopleExport.ts`, keyed by the Zenople
label — currently only **Shuster's Building Components**) get NO RT/OT rows.
Instead the export emits, per driver with `DriverRT` hours `X > 0`:

```
ShiftDifferential     −X   @ RT pay rate   (RT bill rate)
ShiftDifferentialOT   +X   @ OT pay rate   (OT bill rate)
DriverRT               X   @ driver RT rate
DriverOT               …   @ driver OT rate (when present)
```

matching the reference files exactly (Lunar: −7.67@18 / +7.67@27 /
DriverRT 7.67@10 in PD 07.31). No manual post-export step anymore.
