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

const { fastExtractRows } = await import("../lib/parsers/fastExtract.js");
const { buildRosterContext } = await import("../lib/parsers/imageSupport.js");
const { ClaudeModelClient } = await import("../lib/parsers/claude.js");
const { costUsd } = await import("../lib/parsers/pricing.js");
const { writeFile } = await import("node:fs/promises");
type AiExtractedRow = import("../lib/parsers/aiExtract.js").AiExtractedRow;

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

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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

  // A single file rarely covers a whole customer-week: WB Manufacturing
  // uploads one PNG per driver. Scoring one such file against the week's whole
  // punch set charges it for every driver it was never given (the pilot read
  // 26% for exactly this reason). So the unit of evaluation is a
  // (customer, week) GROUP — run every file in it, union the output, score
  // once. That is also the operational question: did this week's uploads
  // produce the right punches?
  const allGroups = new Map<string, Sample[]>();
  for (const s of corpus) {
    const key = `${s.customer}|${s.weekStart}`;
    const g = allGroups.get(key);
    if (g) g.push(s);
    else allGroups.set(key, [s]);
  }
  // Order groups so one per customer comes first: a small --limit then spans
  // customers instead of burning the budget on one customer's twelve weeks.
  const firstOfCustomer: Array<[string, Sample[]]> = [];
  const rest: Array<[string, Sample[]]> = [];
  const seenCustomer = new Set<string>();
  for (const entry of allGroups) {
    if (seenCustomer.has(entry[1][0].customer)) rest.push(entry);
    else {
      seenCustomer.add(entry[1][0].customer);
      firstOfCustomer.push(entry);
    }
  }
  const groups = (wantIds ? [...allGroups] : [...firstOfCustomer, ...rest]).slice(0, limit);
  const fileCount = groups.reduce((n, g) => n + g[1].length, 0);

  console.log(
    `corpus ${corpus.length} pinned -> ${groups.length} customer-weeks / ${fileCount} files   ` +
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
  const kfiIdByName = new Map(drivers.map((d) => [norm(d.name), d.kfiId]));

  const weekCache = new Map<string, Awaited<ReturnType<typeof loadWeek>>>();
  const lessonCache = new Map<string, string[]>();
  const byCustomer = new Map<string, Score>();
  const overall = blank();
  const perSample: unknown[] = [];

  for (const [, samples] of groups) {
    const { customer, weekStart } = samples[0];
    const startedAt = Date.now();
    if (!weekCache.has(weekStart)) weekCache.set(weekStart, await loadWeek(weekStart));
    const { punches, ctActiveKfiIds } = weekCache.get(weekStart)!;

    if (!lessonCache.has(customer)) {
      const r = await api<{
        lessons: Array<{ lessonText: string; active: boolean }>;
      }>(`/customer-extraction-lessons/${encodeURIComponent(customer)}`).catch(
        () => ({ lessons: [] as Array<{ lessonText: string; active: boolean }> }),
      );
      lessonCache.set(
        customer,
        r.lessons.filter((l) => l.active).map((l) => l.lessonText),
      );
    }
    const lessons = useLessons ? lessonCache.get(customer)! : [];

    const truth = toCells(
      punches
        .filter((p) => p.source === "Customer" && (p.customer ?? "") === customer)
        .map((p) => ({ kfiId: p.kfiId, date: p.date, hours: Number(p.hours) })),
    );

    const nameAliasMap = new Map<string, string>();
    for (const a of allAliases) {
      if (a.customer.toLowerCase() === customer.toLowerCase()) {
        nameAliasMap.set(a.nameOnDoc.toLowerCase(), a.kfiId);
      }
    }
    const roster = buildRosterContext({
      customer,
      drivers,
      idMap,
      nameAliasMap,
      ctActiveKfiIds,
    });
    const weekEnd = new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const predictedRows: Array<{
      kfiId: string | null;
      date: string;
      hours: number | null;
    }> = [];
    let unresolved = 0;
    const failures: string[] = [];

    for (const s of samples) {
      const buffer = await apiBytes(`/admin/ai-extract-samples/${s.id}/download`);
      let rows: AiExtractedRow[] = [];
      try {
        const result = await fastExtractRows(
          s.fileName,
          buffer,
          customer,
          weekStart,
          weekEnd,
          s.mimeType,
          undefined,
          roster,
          lessons,
        );
        rows = result.rows;
      } catch (e) {
        failures.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const r of rows) {
        const kfiId =
          r.resolvedKfiId ??
          (r.badgeOrId ? idMap[String(r.badgeOrId)] : undefined) ??
          nameAliasMap.get((r.driverNameOnDoc ?? "").toLowerCase()) ??
          kfiIdByName.get(norm(r.driverNameOnDoc ?? "")) ??
          null;
        if (!kfiId) unresolved += 1;
        predictedRows.push({ kfiId, date: r.date, hours: r.hours ?? null });
      }
    }

    const predicted = toCells(predictedRows);
    const score = blank();
    score.samples = samples.length;
    score.unresolved = unresolved;
    score.truthCells = truth.size;
    score.predCells = predicted.size;
    for (const [key, t] of truth) {
      score.truthHours += t;
      const p = predicted.get(key);
      if (p == null) {
        score.missed += 1;
        score.absErr += t;
        continue;
      }
      const delta = Math.abs(p - t);
      if (delta <= 0.01) score.exact += 1;
      else if (delta <= 0.25) score.close += 1;
      else score.wrong += 1;
      score.absErr += delta;
    }
    for (const [key, p] of predicted) {
      score.predHours += p;
      if (!truth.has(key)) {
        score.extra += 1;
        score.absErr += p;
      }
    }

    if (!byCustomer.has(customer)) byCustomer.set(customer, blank());
    accumulate(byCustomer.get(customer)!, score);
    accumulate(overall, score);

    console.log(
      `  ${pad(customer, 26)} ${weekStart}  ${String(samples.length).padStart(2)}f  ` +
        `truth ${String(score.truthCells).padStart(3)}  pred ${String(score.predCells).padStart(3)}  ` +
        `exact ${String(score.exact).padStart(3)}  miss ${String(score.missed).padStart(3)}  ` +
        `extra ${String(score.extra).padStart(3)}  ` +
        `hrs ${hoursAccuracy(score).toFixed(1).padStart(6)}%  ` +
        `${((Date.now() - startedAt) / 1000).toFixed(0)}s` +
        (failures.length ? `  ERRORS ${failures.length}` : ""),
    );
    perSample.push({
      customer,
      weekStart,
      files: samples.map((s) => ({ id: s.id, fileName: s.fileName, mimeType: s.mimeType })),
      lessonsApplied: lessons.length,
      score,
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
