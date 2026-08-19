# Extraction scoreboard

Measures how close the **current** extractor gets to the punches dispatchers
actually accepted, so a prompt edit, a new lesson, or a model swap can be judged
by a number instead of a hunch.

Script: `artifacts/api-server/src/scripts/extractEval.ts`
Run: `pnpm --filter @workspace/api-server extract-eval -- [flags]`

## Why it replays instead of counting `punches.edited`

The shortcut — count corrected punches, call that the error rate — lies.

DeLallo reads **100% of punches corrected** for eight straight weeks and then
**exactly 0%** from 2026-07-12 onward. That is not a change in dispatcher
behaviour. It is commit `c5a7051` ("honor each customer file's own Hours/Total
column") landing on 07-16 and killing an entire class of error. `edited` is a
historical scar contaminated by bugs that are already dead; mining it reports an
81% failure rate for a customer that is fine today.

So the harness takes the **original file bytes** out of `ai_extract_samples`,
runs **today's** pipeline over them, and compares against the punches that
survived dispatcher review. That measures the code as it stands, which is the
only thing a gate can act on.

## What it scores

`(kfiId, date) -> summed hours`. Cells are counted `exact` (within 0.01h),
`close` (within 0.25h), `wrong`, `missed` (in truth, not produced) or `extra`
(produced, not in truth). The headline is **hours accuracy**: `1 - absErr/truthHours`.

`payType` is deliberately **not** scored. Every customer-source punch in the
corpus is `Reg` — OT is derived downstream by the hours engine — so scoring it
would measure nothing and inflate the result.

## The unit is a WEEK

Not a file, and not a customer. Both smaller units leak, and both leaks were
found by running it wrong first:

- **A file does not cover a customer.** WB Manufacturing uploads one PNG per
  driver. Scoring a single file against the week's whole punch set charges it
  for every driver it was never given (read 26%; scored correctly, 100%).
- **A customer's sheet carries other customers' workers.** Inter. Wire - NY's
  file lists Ladonte Brown, whose hours production files under IWG - El Paso.
  Scored per customer, the extractor is charged for rows it read perfectly.

A week is scored **only** when the corpus holds a pinned file for every customer
with punches that week. Incomplete weeks are skipped and named — never silently
counted as misses.

## Modelling assumptions (read before trusting a number)

1. **Identical bytes are deduped.** Samples 869 and 868 are the same sha256:
   IWG sends one combined report and it is uploaded under both
   *Inter. Wire - NY* and *IWG - El Paso*. Extracting twice and summing reads
   18h for a 9h day.
2. **Driver tag wins.** When one `(kfiId, date)` still comes from two different
   files, the file whose customer matches the driver's tag is kept. The commit
   path stamps every punch with the *upload's* customer
   (`customer: reparsed.customer`), so both imports would file the worker — a
   dispatcher picks one at preview. That choice is not recoverable from the
   document. The tag rule reproduces all three observed splits (Brown ->
   IWG - El Paso, Cerda -> Inter. Wire - NY, Gallegos -> Shuster's), but it is a
   **model, not ground truth**: a week where the dispatcher chose otherwise
   reads as an error here.
3. **Manual punches are excluded from truth.** They are typed in by hand and no
   extractor could produce them. Production's own `customer-uploads` query draws
   the same line (`source=Customer, isManual=false`).

## Known limits

- The completeness check verifies each customer **has** a pinned file that week,
  not that **all** of their files survived the TTL. A customer who uploaded two
  files where only one was pinned will read as misses. This is the most likely
  explanation for 2026-07-12 scoring far below its neighbours.
- Output is **not deterministic** — the same week has scored 95.81% and 94.03%
  on two runs. Hence the tolerance band on the gate; never gate on equality.
- Only weeks present in the pinned corpus can be scored. Anything older than the
  pin date is gone (confirmed samples live 90 days).

## Usage

    export KFI_OT_BASE_URL="https://<host>"
    export KFI_OT_COOKIE="kfi.sid=..."       # admin session
    export ANTHROPIC_API_KEY="sk-ant-..."

    # a quick look at the three most recent weeks
    extract-eval -- --limit 3

    # everything, written to a baseline
    extract-eval -- --all --out eval-baselines/lessons-on.json

    # what a change did, with a pass/fail verdict
    extract-eval -- --all --compare eval-baselines/lessons-on.json

    # price the lessons loop
    extract-eval -- --customers "Shuster's Building Components" --no-lessons

Flags: `--limit N` · `--all` · `--customers "A,B"` · `--samples 1,2,3` ·
`--no-lessons` · `--model <id>` · `--diff` (print the offending cells with
driver names) · `--out <file>` · `--compare <file>` · `--tolerance <pp>`.

## Gating

**Do not put this in CI.** A full run is ~116 model calls, ~30 minutes and ~$19,
and depends on prod being reachable. It is a *deliberate* pre-merge check, not a
per-push one.

Before merging anything that touches the extraction prompt, a customer lesson,
an import rule, or `CLAUDE_EXTRACT_MODEL`:

    extract-eval -- --all --compare artifacts/api-server/eval-baselines/lessons-on.json

Exits non-zero if any customer — or the overall figure — drops more than the
tolerance (default 3pp). Re-freeze the baseline only when a change is a
deliberate, understood improvement.

## Cost and safety

~$0.16–0.22 per file on `claude-sonnet-5`; a full corpus run is ~$19. Spend is
tallied and printed per run.

The harness **never touches a database**. Prod is read over the admin HTTP API
(`GET` only, with retry), extraction runs locally on downloaded bytes, and
nothing is written back.
