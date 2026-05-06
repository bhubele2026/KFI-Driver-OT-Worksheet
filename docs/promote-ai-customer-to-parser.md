# Promoting an AI-imported customer to a deterministic parser

When the same customer keeps coming through the "New customer file…" (AI extract)
flow week after week, it's worth writing a real parser for them. Deterministic
parsers are faster, free to run, and immune to LLM drift. The customer-files
panel surfaces an amber `AI · N weeks` badge to flag candidates.

## When to promote

Promote when **any** of these are true:

- The same customer name has been AI-imported 3+ weeks in a row (badge count ≥ 3).
- The dispatcher tells you the customer is now part of the regular weekly run.
- The AI extract is consistently producing zero or wrong rows for that customer
  (the LLM is the wrong tool — write a parser).

## Step-by-step checklist

1. **Grab a fixture.** Sign in as an admin and open **Admin → AI samples**
   (`/admin/ai-samples`). The customer-files panel's amber `AI · N weeks`
   badge deep-links straight to that customer's stashed files. Pick a row
   marked **Confirmed** and click **Download** — prefer a confirmed sample
   over an unconfirmed one because confirmed files are the ones the
   dispatcher actually used.

   Save the file to `artifacts/api-server/src/lib/parsers/__tests__/fixtures/<customer>-<weekStart>.{xlsx,pdf}`.

   If you'd rather hit the API directly:
   ```
   GET /api/admin/ai-extract-samples?customer=<Customer Display Name>
   GET /api/admin/ai-extract-samples/<id>/download
   ```
   - Confirmed AI samples are retained for 90 days; unconfirmed for 24h. Don't
     wait — pull the fixture as soon as you decide to promote.
   - If the file contains real PII you don't want in the repo, redact it
     (replace driver names with synthetic ones, blank out addresses) before
     committing. Keep the row/column shape intact.

2. **Write the parser.** Add `<customer>.ts` next to the other parsers in
   `artifacts/api-server/src/lib/parsers/`. Match the existing parser
   signatures in `lib/parsers/types.ts`. Aim for:
   - Pure functions over `Buffer` → `ParsedPunch[]`.
   - Throw a clear "scanned image" / "format drift" error when the input
     doesn't look right (don't return empty).
   - Use `lib/parsers/customers.ts` `KNOWN_CUSTOMERS` for the canonical
     `displayName`.

3. **Register the customer.** Add an entry to `KNOWN_CUSTOMERS` in
   `artifacts/api-server/src/lib/parsers/customers.ts`:
   ```ts
   {
     displayName: "<Same name the AI flow used>",
     keywords: ["<lowercase substring(s) that appear in the filename>"],
     extensions: ["xlsx"], // or ["pdf"], or both
   },
   ```
   Use the **same** `displayName` the AI flow has been writing — that way
   existing punches, customer-upload-attempts rows, and the dashboard grouping
   continue to line up without a backfill.

4. **Wire it into the router.** Add the new parser to the dispatch table in
   `artifacts/api-server/src/lib/parsers/index.ts` so `detectAndParseFile`
   picks it up.

5. **Add a drift fixture.** In
   `artifacts/api-server/src/lib/parsers/__tests__/`, add a test that loads
   your fixture and asserts at least:
   - Punch count matches a known good number.
   - The driver IDs all exist in the roster.
   - Total hours match the expected value (sum of the file).
   This is what catches silent format drift later. See the existing tests for
   the established style.

6. **Run the suite.**
   ```
   pnpm run test
   pnpm run typecheck
   ```

7. **Verify locally.** Re-upload the fixture file via the customer-files panel
   (no longer the "New customer file…" button). The `AI · N weeks` badge
   disappears once the customer is in `KNOWN_CUSTOMERS` and the row routes
   through the deterministic parser.

8. **Update `replit.md`** under "Architecture decisions" if you added a new
   keyword convention or non-obvious routing rule.

## Cleanup

Once the parser is live, old AI samples for that customer will continue to age
out automatically (24h unconfirmed, 90d confirmed). No manual purge required.
