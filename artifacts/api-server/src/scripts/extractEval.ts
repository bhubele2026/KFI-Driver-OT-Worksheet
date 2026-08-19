/**
 * Extraction scoreboard - how close does the CURRENT extractor get to the
 * punches the dispatchers actually accepted?
 *
 * WHY REPLAY INSTEAD OF MINING `punches.edited`
 * ---------------------------------------------
 * The obvious shortcut is to count corrected punches and call that the error
 * rate. It lies. DeLallo shows 100% of its punches corrected for eight
 * straight weeks and then exactly 0% from 2026-07-12 on - not because the
 * dispatchers gave up, but because c5a7051 ("honor each customer file's own
 * Hours/Total column") landed on 07-16 and killed a whole class of error.
 * `edited` is a historical scar, contaminated by bugs that are already dead.
 * Mining it would report an 81% failure rate for a customer that is fine now.
 *
 * So: take the ORIGINAL file bytes we stashed, run today's extractor over
 * them, and compare against the punches that survived dispatcher review. That
 * measures the code as it stands, which is the only thing a gate can act on.
 *
 * WHAT IT SCORES
 * --------------
 * The payroll-meaningful unit is hours per driver per day, so the harness
 * reduces both sides to (kfiId, date) -> summed hours and compares cells.
 * `payType` is deliberately NOT scored: every customer-source punch in the
 * corpus is `Reg` (OT is derived downstream by the hours engine), so scoring
 * it would measure nothing and inflate the result.
 *
 * SAFETY
 * ------
 * Never touches a database. Prod is read over the admin HTTP API; the
 * extractor runs locally against downloaded bytes. The only cost is Anthropic
 * tokens, tallied and printed per run.
 *
 * USAGE
 * -----
 *   export KFI_OT_BASE_URL="https://<host>"
 *   export KFI_OT_COOKIE="kfi.sid=..."
 *   export ANTHROPIC_API_KEY="sk-ant-..."
 *
 *   pnpm --filter @workspace/api-server extract-eval -- --limit 3
 *   pnpm --filter @workspace/api-server extract-eval -- --customers "Penda Corp" --no-lessons
 *   pnpm --filter @workspace/api-server extract-eval -- --all --out baseline.json
 *
 * `--no-lessons` runs with the per-customer lessons suppressed, so a paired
 * run measures exactly what the lessons loop is worth.
 */

// The extractor's import chain builds a pg Pool at module load and throws
// without a URL. Point it at nowhere - this script issues no queries - and do
// it BEFORE the dynamic imports below.
process.env.DATABASE_URL ??= "postgres://eval:eval@127.0.0.1:1/eval-no-db";

// Pin the model BEFORE importing the client, which reads CLAUDE_EXTRACT_MODEL
// at construction. Without this the eval inherits DEFAULT_CLAUDE_MODEL
// (claude-opus-4-8) while production runs claude-sonnet-5 from its container
// env — so a run would silently score a model nobody ships, at 5x the cost.
// The default here mirrors prod; --model overrides it for comparison runs.
const MODEL = (() => {
  const i = process.argv.indexOf("--model");
  return i >= 0 ? String(process.argv[i + 1]) : "claude-sonnet-5";
})();
process.env.CLAUDE_EXTRACT_MODEL = MODEL;

// Call production's WHOLE known-customer pipeline, not just the extractor:
// extraction, date normalization, the week-window filter, the census->fleet
// resolution ladder with its Connecteam hard block, and the total-row drops.
// imageSupport.ts touches no database (every input is injected), so the real
// path runs here unchanged. Scoring raw extractor output instead made the
// harness invent "extra" cells for rows production drops downstream, and let
// it resolve drivers production would have refused.
const { extractImageForKnownCustomer } = await import(
  "../lib/parsers/imageSupport.js"
);
const { ClaudeModelClient } = await import("../lib/parsers/claude.js");
const { costUsd } = await import("../lib/parsers/pricing.js");
const { writeFile } = await import("node:fs/promises");
const { createHash } = await import("node:crypto");

const BASE = (process.env.KFI_OT_BASE_URL ?? "").replace(/\/+$/, "");
const COOKIE = process.env.KFI_OT_COOKIE ?? "";

for (const [name, value] of [
  ["KFI_OT_BASE_URL", BASE],
  ["KFI_OT_COOKIE", COOKIE],
  ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY ?? ""],
]) {
  if (!value) {
    console.error(`Missing env: ${name}`);
    process.exit(2);
  }
}

// -- cost meter -----------------------------------------------------------
// fastExtractRows returns no budget summary, so tally at the model client.
const spend = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
{
  const proto = ClaudeModelClient.prototype as unknown as {
    generate: (o: unknown) => Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number; model: string };
    }>;
  };
  const original = proto.generate;
  proto.generate = async function patched(o: unknown) {
    const res = await original.call(this, o);
    spend.calls += 1;
    spend.inputTokens += res.usage.inputTokens;
    spend.outputTokens += res.usage.outputTokens;
    spend.usd += costUsd(
      res.usage.model,
      res.usage.inputTokens,
      res.usage.outputTokens,
    );
    return res;
  };
}

// -- prod reads -----------------------------------------------------------
async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, { headers: { cookie: COOKIE } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}
async function apiBytes(path: string): Promise<Buffer> {
  const res = await fetch(`${BASE}/api${path}`, { headers: { cookie: COOKIE } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

interface Sample {
  id: number;
  weekStart: string;
  customer: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  pinned: boolean;
  confirmed: boolean;
}
interface Punch {
  kfiId: string;
  customer: string | null;
  source: string;
  date: string;
  hours: number | string;
  isManual: boolean;
}

/**
 * Ground truth plus the Connecteam-active set for one week, fetched once and
 * shared by every sample for that week. `ctActiveKfiIds` matters: the standing
 * 2026-08-04 rule hard-blocks customer time from attaching to a driver with no
 * Connecteam time that week, so omitting it would let the harness resolve
 * drivers production would have refused.
 */
async function loadWeek(weekStart: string) {
  const summary = await api<{ rows: Array<{ kfiId: string }> }>(
    `/weeks/${weekStart}/summary`,
  );
  const ids = summary.rows.map((r) => r.kfiId);
  const punches: Punch[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(i, i + CONCURRENCY).map((kfiId) =>
        api<{ punches: Punch[] }>(`/weeks/${weekStart}/drivers/${kfiId}`)
          .then((d) => d.punches)
          .catch(() => [] as Punch[]),
      ),
    );
    for (const b of batch) punches.push(...b);
  }
  const ctActiveKfiIds = new Set(
    punches.filter((p) => p.source === "Driver").map((p) => p.kfiId),
  );
  return { punches, ctActiveKfiIds };
}

/** (kfiId, date) -> summed hours. Both sides reduce to this. */
function toCells(
  rows: Array<{ kfiId: string | null; date: string; hours: number | null }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.kfiId || !r.date || r.hours == null) continue;
    const key = `${r.kfiId}|${r.date}`;
    m.set(key, (m.get(key) ?? 0) + r.hours);
  }
  return m;
}

interface Score {
  samples: number;
  truthCells: number;
  predCells: number;
  exact: number;
  close: number;
  wrong: number;
  missed: number;
  extra: number;
  unresolved: number;
  truthHours: number;
  predHours: number;
  absErr: number;
}
const blank = (): Score => ({
  samples: 0, truthCells: 0, predCells: 0, exact: 0, close: 0, wrong: 0,
  missed: 0, extra: 0, unresolved: 0, truthHours: 0, predHours: 0, absErr: 0,
});
function accumulate(into: Score, from: Score): void {
  for (const k of Object.keys(into) as Array<keyof Score>) into[k] += from[k];
}
/** Share of the week's hours the extractor got right. Negative is possible
 *  (inventing hours costs more than missing them), which is the honest signal. */
const hoursAccuracy = (s: Score): number =>
  s.truthHours > 0 ? (1 - s.absErr / s.truthHours) * 100 : 0;

const pad = (s: string, n: number): string => s.slice(0, n - 1).padEnd(n);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const useLessons = !argv.includes("--no-lessons");
  const showDiff = argv.includes("--diff");
  const limit = Number(flag("--limit") ?? (argv.includes("--all") ? 9999 : 3));
  const wantCustomers = flag("--customers")
    ?.split(",")
    .map((s) => s.trim().toLowerCase());
  const wantIds = flag("--samples")?.split(",").map((s) => Number(s.trim()));
  const outFile = flag("--out");

  const all = await api<Sample[]>("/admin/ai-extract-samples");
  let corpus = all.filter(
    (s) => s.pinned && s.confirmed && !s.customer.startsWith("ZZZ-E2E"),
  );
  if (wantIds) corpus = corpus.filter((s) => wantIds.includes(s.id));
  if (wantCustomers) {
    corpus = corpus.filter((s) => wantCustomers.includes(s.customer.toLowerCase()));
  }

  // The unit of evaluation is a WEEK, not a file and not a customer.
  //
  // Two leaks force this, both found by running it wrong first. A single file
  // rarely covers a whole customer (WB Manufacturing uploads one PNG per
  // driver), and a customer's sheet routinely lists workers who belong to a
  // DIFFERENT customer - Inter. Wire - NY's file carries Ladonte Brown, whose
  // hours production correctly files under IWG - El Paso. Scoring per customer
  // charged the extractor for reading rows it read perfectly well.
  //
  // A week closes both: every file goes in, every punch comes out. A week is
  // only scored when the corpus holds a file for EVERY customer with punches
  // that week - otherwise a missing file reads as an extraction miss.
  const weekFiles = new Map<string, Sample[]>();
  for (const s of corpus) {
    const g = weekFiles.get(s.weekStart);
    if (g) g.push(s);
    else weekFiles.set(s.weekStart, [s]);
  }
  const weeks = [...weekFiles.keys()].sort().reverse().slice(0, limit);
  const fileCount = weeks.reduce((n, w) => n + weekFiles.get(w)!.length, 0);

  console.log(
    `corpus ${corpus.length} pinned -> ${weeks.length} weeks / ${fileCount} files   ` +
      `model=${MODEL}   lessons=${useLessons ? "ON" : "OFF"}\n`,
  );

  const drivers = (
    await api<
      Array<{
        kfiId: string;
        name: string;
        customer: string | null;
        deactivated: boolean;
        isArchived: boolean;
      }>
    >("/admin/drivers")
  )
    .filter(
      (d) => !d.deactivated && !d.isArchived && !/e2e/i.test(`${d.kfiId} ${d.name}`),
    )
    .map((d) => ({ kfiId: d.kfiId, name: d.name, customer: d.customer }));

  // Mirrors loadMergedIdMap() in routes/weeks.ts: driver_id_aliases is the
  // single source of truth for badge -> kfiId.
  const idMap: Record<string, string> = {};
  const idAliases = await api<{
    aliases: Array<{ externalId: string; kfiId: string }>;
  }>("/driver-id-aliases");
  for (const a of idAliases.aliases) idMap[a.externalId] = a.kfiId;

  const allAliases = (
    await api<{
      aliases: Array<{ customer: string; nameOnDoc: string; kfiId: string }>;
    }>("/customer-aliases")
  ).aliases;
  const kfiSet = new Set(drivers.map((d) => d.kfiId));
  const nameByKfi = new Map(drivers.map((d) => [d.kfiId, d.name]));

  const weekCache = new Map<string, Awaited<ReturnType<typeof loadWeek>>>();
  const lessonCache = new Map<string, string[]>();
  const byCustomer = new Map<string, Score>();
  const overall = blank();
  const perSample: unknown[] = [];

  const tagByKfi = new Map(drivers.map((d) => [d.kfiId, d.customer ?? "(untagged)"]));
  const skipped: string[] = [];

  for (const weekStart of weeks) {
    const samples = weekFiles.get(weekStart)!;
    const startedAt = Date.now();
    const { punches, ctActiveKfiIds } = await loadWeek(weekStart);

    // File-derived truth only: manual punches are typed in by a dispatcher and
    // no extractor could ever produce them. Production's own customer-uploads
    // query draws the same line (source=Customer, isManual=false).
    const weekTruth = punches.filter(
      (p) => p.source === "Customer" && !p.isManual,
    );
    const customersWithPunches = new Set(weekTruth.map((p) => p.customer ?? "-"));
    const customersWithFiles = new Set(samples.map((s) => s.customer));
    const absent = [...customersWithPunches].filter((c) => !customersWithFiles.has(c));
    if (absent.length) {
      skipped.push(`${weekStart} (no pinned file for ${absent.join(", ")})`);
      continue;
    }

    const truth = new Map<string, number>();
    const truthCustomer = new Map<string, string>();
    for (const p of weekTruth) {
      const key = `${p.kfiId}|${p.date}`;
      truth.set(key, (truth.get(key) ?? 0) + Number(p.hours));
      truthCustomer.set(key, p.customer ?? "-");
    }

    // Two files in a week can carry the same rows, and both cases are the
    // harness's problem rather than the extractor's:
    //
    // 1. IDENTICAL BYTES. IWG sends one combined report and the dispatcher
    //    uploads it under both "Inter. Wire - NY" and "IWG - El Paso" -
    //    samples 869 and 868 are the same sha256. Extracting it twice and
    //    summing reads 18h for a 9h day. Hash first, extract once.
    // 2. SHARED WORKER, DIFFERENT FILES. Jose Gallegos appears on Burnett
    //    Dairy's sheet and Shuster's. The commit path stamps every punch with
    //    the UPLOAD's customer (`customer: reparsed.customer`), so both
    //    imports would file him - the dispatcher's preview picks one. That
    //    choice isn't recoverable from the document, so we model it: when the
    //    same (kfiId, date) comes from more than one file, the file whose
    //    customer matches the driver's tag wins. That reproduces all three
    //    observed cases (Brown -> IWG - El Paso, Cerda -> Inter. Wire - NY,
    //    Gallegos -> Shuster's). It is a MODEL, not ground truth; a week whose
    //    dispatcher chose otherwise will read as an error here.
    const perFile: Array<{ customer: string; cells: Map<string, number> }> = [];
    let unresolved = 0;
    let duplicateFiles = 0;
    const dropped = new Map<string, number>();
    const failures: string[] = [];
    const seenBytes = new Map<string, string>();

    for (const s of samples) {
      if (!lessonCache.has(s.customer)) {
        const r = await api<{ lessons: Array<{ lessonText: string; active: boolean }> }>(
          `/customer-extraction-lessons/${encodeURIComponent(s.customer)}`,
        ).catch(() => ({ lessons: [] as Array<{ lessonText: string; active: boolean }> }));
        lessonCache.set(s.customer, r.lessons.filter((l) => l.active).map((l) => l.lessonText));
      }
      const lessons = useLessons ? lessonCache.get(s.customer)! : [];
      const nameAliasMap = new Map<string, string>();
      for (const a of allAliases) {
        if (a.customer.toLowerCase() === s.customer.toLowerCase()) {
          nameAliasMap.set(a.nameOnDoc.toLowerCase(), a.kfiId);
        }
      }
      const weekEnd = new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const buffer = await apiBytes(`/admin/ai-extract-samples/${s.id}/download`);
      const digest = createHash("sha256").update(buffer).digest("hex");
      const twin = seenBytes.get(digest);
      if (twin) {
        duplicateFiles += 1;
        continue;
      }
      seenBytes.set(digest, s.customer);
      try {
        const result = await extractImageForKnownCustomer({
          fileName: s.fileName,
          buffer,
          mimeType: s.mimeType,
          customer: s.customer,
          weekStart,
          weekEnd,
          idMap,
          drivers,
          kfiSet,
          nameAliasMap,
          ctActiveKfiIds,
          aiOpts: { lessons },
        });
        perFile.push({
          customer: s.customer,
          cells: toCells(
            result.punches.map((punch) => ({
              kfiId: punch.kfiId,
              date: punch.date,
              hours: punch.hours,
            })),
          ),
        });
        unresolved += result.pendingNamedRows?.length ?? 0;
        for (const d of result.droppedRows ?? []) {
          dropped.set(d.reason, (dropped.get(d.reason) ?? 0) + 1);
        }
      } catch (e) {
        failures.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const predicted = new Map<string, number>();
    for (const key of new Set(perFile.flatMap((f) => [...f.cells.keys()]))) {
      const from = perFile.filter((f) => f.cells.has(key));
      const tag = tagByKfi.get(key.split("|")[0]);
      const winner = from.find((f) => f.customer === tag) ?? from[0];
      predicted.set(key, winner.cells.get(key)!);
    }
    const week = blank();
    week.samples = samples.length;
    week.unresolved = unresolved;
    week.truthCells = truth.size;
    week.predCells = predicted.size;
    const sub = (c: string): Score => {
      let v = byCustomer.get(c);
      if (!v) { v = blank(); byCustomer.set(c, v); }
      return v;
    };

    for (const [key, t] of truth) {
      const c = sub(truthCustomer.get(key)!);
      week.truthHours += t; c.truthHours += t; c.truthCells += 1;
      const pv = predicted.get(key);
      if (pv == null) {
        week.missed += 1; c.missed += 1; week.absErr += t; c.absErr += t;
        continue;
      }
      const delta = Math.abs(pv - t);
      if (delta <= 0.01) { week.exact += 1; c.exact += 1; }
      else if (delta <= 0.25) { week.close += 1; c.close += 1; }
      else { week.wrong += 1; c.wrong += 1; }
      week.absErr += delta; c.absErr += delta;
    }
    for (const [key, pv] of predicted) {
      week.predHours += pv;
      if (truth.has(key)) continue;
      const c = sub(tagByKfi.get(key.split("|")[0]) ?? "(untagged)");
      week.extra += 1; c.extra += 1; c.predCells += 1;
      week.absErr += pv; c.absErr += pv;
    }
    for (const c of new Set(samples.map((s) => s.customer))) sub(c).samples += 1;

    accumulate(overall, week);
    console.log(
      `  ${weekStart}  ${String(samples.length).padStart(2)}f  ` +
        `truth ${String(week.truthCells).padStart(4)}  pred ${String(week.predCells).padStart(4)}  ` +
        `exact ${String(week.exact).padStart(4)}  close ${String(week.close).padStart(3)}  ` +
        `wrong ${String(week.wrong).padStart(3)}  miss ${String(week.missed).padStart(3)}  ` +
        `extra ${String(week.extra).padStart(3)}  ` +
        `hrs ${hoursAccuracy(week).toFixed(2).padStart(7)}%  ` +
        `${((Date.now() - startedAt) / 1000).toFixed(0)}s` +
        (duplicateFiles ? `  dup-files ${duplicateFiles}` : "") +
        (dropped.size ? `  dropped[${[...dropped].map(([r, n]) => `${r}:${n}`).join(" ")}]` : "") +
        (failures.length ? `  ERRORS ${failures.length}` : ""),
    );
    if (showDiff && (week.extra || week.missed || week.wrong)) {
      const who = (key: string): string => {
        const [kfiId, date] = key.split("|");
        return `${date}  ${kfiId} ${nameByKfi.get(kfiId) ?? "(not on roster)"}`;
      };
      for (const [key, pv] of predicted) {
        if (!truth.has(key)) console.log(`      EXTRA   ${who(key)}  ${pv}h  [tag ${tagByKfi.get(key.split("|")[0]) ?? "?"}]`);
      }
      for (const [key, t] of truth) {
        const pv = predicted.get(key);
        if (pv == null) console.log(`      MISSED  ${who(key)}  ${t}h  [${truthCustomer.get(key)}]`);
        else if (Math.abs(pv - t) > 0.25) console.log(`      WRONG   ${who(key)}  got ${pv}h want ${t}h  [${truthCustomer.get(key)}]`);
      }
    }
    perSample.push({
      weekStart,
      files: samples.map((s) => ({ id: s.id, customer: s.customer, fileName: s.fileName, mimeType: s.mimeType })),
      score: week,
      dropped: Object.fromEntries(dropped),
      errors: failures,
    });
  }

  const header =
    pad("customer", 26) + "n".padStart(3) + "truth".padStart(7) +
    "exact".padStart(7) + "close".padStart(7) + "wrong".padStart(7) +
    "miss".padStart(6) + "extra".padStart(7) + "unres".padStart(7) +
    "hrs-acc".padStart(10);
  const row = (label: string, s: Score): string =>
    pad(label, 26) + String(s.samples).padStart(3) + String(s.truthCells).padStart(7) +
    String(s.exact).padStart(7) + String(s.close).padStart(7) + String(s.wrong).padStart(7) +
    String(s.missed).padStart(6) + String(s.extra).padStart(7) +
    String(s.unresolved).padStart(7) + `${hoursAccuracy(s).toFixed(1)}%`.padStart(10);

  console.log(`\n${header}`);
  for (const [customer, s] of [...byCustomer.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    console.log(row(customer, s));
  }
  console.log(row("TOTAL", overall));
  if (skipped.length) {
    console.log(`\nskipped ${skipped.length} week(s) - corpus incomplete, would read as misses:`);
    for (const line of skipped) console.log(`  ${line}`);
  }

  console.log(
    `\nspend: ${spend.calls} calls  ${spend.inputTokens.toLocaleString()} in / ` +
      `${spend.outputTokens.toLocaleString()} out  $${spend.usd.toFixed(4)}` +
      `   (~$${(spend.usd / Math.max(1, overall.samples)).toFixed(4)}/sample)`,
  );

  if (outFile) {
    await writeFile(
      outFile,
      JSON.stringify(
        {
          model: MODEL,
          lessons: useLessons,
          overall,
          byCustomer: Object.fromEntries(byCustomer),
          perSample,
          spend,
        },
        null,
        2,
      ),
    );
    console.log(`wrote ${outFile}`);
  }
}

await main();

export {};
