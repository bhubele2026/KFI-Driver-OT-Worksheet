# Parser drift fixtures

Each subdirectory is a Sunday week start (`YYYY-MM-DD`) holding one raw
customer export per parser. The drift suite at
`../parsers.test.ts` runs every parser against every fixture week and asserts
the punch count and total hours stay within tolerance.

## Layout

```
fixtures/
  2026-04-26/
    Adient.xlsx
    Burnett_G.xlsx
    Greystone.xlsx
    IWG.pdf
    LSI.xlsx
    Penda.xlsx
    Trienda.xlsx
    Zenople.xlsx
  2026-07-12/         # add a newer week alongside, don't replace
    ...
```

Filenames must contain the customer keyword the routing layer recognises
(see `KNOWN_CUSTOMERS` in `lib/parsers/customers.ts`).

## When to refresh

- A customer changes their export format and the existing fixture starts
  failing — capture a new clean week and pin it.
- At least once per quarter, even if nothing has broken, so the baseline
  stays representative of current exports.
- Whenever the KFI driver roster shifts in a way that affects what ids
  appear in customer files (update `FIXTURE_KFI_IDS` in the test).

## How to refresh

1. Drop the raw file into `fixtures/<week-start>/<File>` using the existing
   filename for that customer.
2. Add or update the matching row in the `BASELINES` table inside
   `parsers.test.ts`. The test guards that every fixture directory has a
   `BASELINES` entry and vice-versa, so partial changes will fail loudly.
3. Run `pnpm run test`. If the parser numbers are correct, the assertion
   will tell you the actual `length` and total hours — paste those into the
   baseline row and re-run.
4. Aim for **1–3 weeks of coverage per customer**. When a fixture is older
   than ~3 quarters and a newer week is already pinned, delete the stale
   fixture file and its `BASELINES` row in the same change.

Keeping multiple weeks per customer means a single anomalous week never has
to be both the reference and the verification.
