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

Per-driver identity + rates (SSN, JobId, PersonId, Assignment, 8 pay/bill rates)
come from `driver_payroll_profiles`. Export is gated by `computeReadiness`:
every driver with hours must be marked **good** and have the 5 identity fields.

## PPE column — per-customer pay-period-end date

Zenople stamps each assignment's own pay-period-END date. Most KFI customers end
their week on **Saturday** (the app's Sun→Sat week-end), but four end on
**Sunday**: **Adient, DeLallo Foods, Schuette Metals, WB Manufacturing**. The
export stamps the Sunday customers one day later (week-end + 1); it does **not**
re-bucket their hours into a different week — only the stamped date shifts.

- Config: `SUNDAY_ENDING_CUSTOMERS` / `payPeriodEndDowFor()` in
  `zenopleExport.ts` (keyed by the exact `zenopleCustomer` label).
- Date math: `periodEndFor(weekStart, endDow)` in `lib/time.ts`.
- If a customer's pay-period-end day changes, edit `SUNDAY_ENDING_CUSTOMERS`.

## Shift differential — MANUAL step (not automated)

A few **Shuster's Building Components** drivers earn a shift differential that
Zenople records as a re-rating pair the app does **not** generate:

```
ShiftDifferential     −X   @ $18.00     (backs the hours out of the base rate)
ShiftDifferentialOT   +X   @ $25.50     (re-adds them at the differential OT rate)
```

where `X` = that driver's `DriverRT` hours (e.g. Balderas 7.48, Moody 18.0 in
the reference). Net pay units are 0; only the rate changes. This was hand-entered
in Zenople historically and remains a **manual post-export step**: after
downloading the workbook, add the two rows per affected Shuster's driver by hand,
matching the pattern above. Revisit automation only if this recurs across more
drivers/customers.
