/**
 * AI-extract sample corpus: census, pin plan, and pin.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ai_extract_samples` stashes the original bytes of every AI-extracted
 * customer file plus what the extractor made of it. The table comment calls
 * this out as fixture material — "so an engineer can use it as a fixture when
 * promoting the customer to a deterministic parser" — and it is also the only
 * graded corpus we have for measuring extraction accuracy, because the
 * dispatcher-corrected answer lives in `punches` right next to it.
 *
 * But it is on a TTL. `lib/aiExtractSampleCleanup.ts` sweeps hourly:
 *
 *     DELETE FROM ai_extract_samples
 *     WHERE expires_at <= now() AND pinned = false
 *
 * Unconfirmed rows last 24h; confirmed rows last 90 days; `pinned = true` is
 * exempt forever. Nothing pins anything today, so every customer format we saw
 * more than 90 days ago is already gone and the rest is on a rolling clock.
 * Re-collecting a format means waiting for that customer to upload again.
 *
 * This script reads the corpus through the existing admin API (no DB
 * credentials, no new endpoints), reports what is there and what is about to
 * expire, proposes a diverse set worth keeping, and — only on an explicit
 * separate invocation — pins it.
 *
 *   GET   /admin/ai-extract-samples          → list (<=500, newest first)
 *   PATCH /admin/ai-extract-samples/:id/pin  → { pinned: boolean }, audit-logged
 *
 * USAGE
 * -----
 *   export KFI_OT_BASE_URL="https://<host>"
 *   export KFI_OT_COOKIE="<session cookie from an admin browser session>"
 *
 *   census                          # read-only report
 *   plan   --out corpus.json [--per-customer 3]
 *   pin    --in  corpus.json        # the only command that writes
 *
 * `census` and `plan` are strictly read-only. `pin` writes, one row at a time,
 * and every write is audit-logged server-side against the acting admin.
 */

interface SampleRow {
  id: number;
  weekStart: string;
  customer: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  confirmed: boolean;
  pinned: boolean;
  uploadedByEmail: string | null;
}

const BASE = process.env.KFI_OT_BASE_URL?.replace(/\/+$/, "") ?? "";
const COOKIE = process.env.KFI_OT_COOKIE ?? "";

function requireEnv(): void {
  const missing: string[] = [];
  if (!BASE) missing.push("KFI_OT_BASE_URL");
  if (!COOKIE) missing.push("KFI_OT_COOKIE");
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(2);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      cookie: COOKIE,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const DAY = 86_400_000;
const daysUntil = (iso: string): number =>
  Math.floor((new Date(iso).getTime() - Date.now()) / DAY);

/** Coarse format key. The list endpoint doesn't expose lane, so shape the
 *  corpus on what it does give us: mime type plus the file's extension, which
 *  is what actually varies between customer formats. */
function formatKey(r: SampleRow): string {
  const ext = (r.fileName.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "none").toLowerCase();
  return `${r.mimeType.split(";")[0]}|${ext}`;
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}

async function fetchAll(): Promise<SampleRow[]> {
  return api<SampleRow[]>("/admin/ai-extract-samples");
}

function census(rows: SampleRow[]): void {
  const pinned = rows.filter((r) => r.pinned);
  const confirmed = rows.filter((r) => r.confirmed);

  console.log(`\n=== CORPUS ===`);
  console.log(`visible rows      ${rows.length}${rows.length === 500 ? "  (API cap — there may be more)" : ""}`);
  console.log(`confirmed         ${confirmed.length}   (these have a dispatcher-corrected answer in punches)`);
  console.log(`pinned            ${pinned.length}   ${pinned.length === 0 ? "← nothing is protected from the TTL sweep" : ""}`);

  const byCustomer = new Map<string, SampleRow[]>();
  for (const r of rows) {
    const k = r.customer;
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k)!.push(r);
  }

  console.log(`\n=== BY CUSTOMER (${byCustomer.size}) ===`);
  console.log(
    `${pad("customer", 26)}${pad("n", 5)}${pad("conf", 6)}${pad("pin", 5)}${pad("formats", 9)}${pad("weeks", 24)}soonest expiry`,
  );
  const sorted = [...byCustomer.entries()].sort((a, b) => {
    const ea = Math.min(...a[1].map((r) => daysUntil(r.expiresAt)));
    const eb = Math.min(...b[1].map((r) => daysUntil(r.expiresAt)));
    return ea - eb;
  });
  for (const [customer, rs] of sorted) {
    const formats = new Set(rs.map(formatKey));
    const weeks = [...new Set(rs.map((r) => r.weekStart))].sort();
    const soonest = Math.min(...rs.filter((r) => !r.pinned).map((r) => daysUntil(r.expiresAt)));
    const weekSpan = weeks.length === 1 ? weeks[0] : `${weeks[0]} → ${weeks[weeks.length - 1]}`;
    console.log(
      pad(customer, 26) +
        pad(String(rs.length), 5) +
        pad(String(rs.filter((r) => r.confirmed).length), 6) +
        pad(String(rs.filter((r) => r.pinned).length), 5) +
        pad(String(formats.size), 9) +
        pad(weekSpan, 24) +
        (Number.isFinite(soonest) ? `${soonest}d` : "pinned"),
    );
  }

  for (const horizon of [7, 30]) {
    const atRisk = rows.filter((r) => !r.pinned && daysUntil(r.expiresAt) <= horizon);
    const lostFormats = new Set<string>();
    for (const r of atRisk) {
      const survivors = rows.filter(
        (s) => s.customer === r.customer && formatKey(s) === formatKey(r) && (s.pinned || daysUntil(s.expiresAt) > horizon),
      );
      if (survivors.length === 0) lostFormats.add(`${r.customer} / ${formatKey(r)}`);
    }
    console.log(`\n=== EXPIRING WITHIN ${horizon} DAYS ===`);
    console.log(`rows            ${atRisk.length}`);
    console.log(`formats lost    ${lostFormats.size}${lostFormats.size ? "  ← no other sample of these survives" : ""}`);
    for (const f of [...lostFormats].sort()) console.log(`   ${f}`);
  }

  const singletons = sorted.filter(([, rs]) => rs.length === 1).map(([c]) => c);
  if (singletons.length) {
    console.log(`\n=== SINGLE-SAMPLE CUSTOMERS (${singletons.length}) ===`);
    console.log(`Losing one of these loses the format entirely:`);
    console.log(`   ${singletons.join(", ")}`);
  }
}

/** Greedy diversity pick: for each customer, keep the widest spread of
 *  (format, week) we can, preferring confirmed rows — an unconfirmed row has
 *  no corrected answer to score against, so it is worth much less as a
 *  fixture — then preferring whichever expires soonest, since a row with
 *  90 days left is not the one in danger. */
function plan(rows: SampleRow[], perCustomer: number): SampleRow[] {
  const byCustomer = new Map<string, SampleRow[]>();
  for (const r of rows) {
    if (r.pinned) continue;
    if (!byCustomer.has(r.customer)) byCustomer.set(r.customer, []);
    byCustomer.get(r.customer)!.push(r);
  }
  const picked: SampleRow[] = [];
  for (const [, rs] of byCustomer) {
    const ranked = rs.slice().sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
      return daysUntil(a.expiresAt) - daysUntil(b.expiresAt);
    });
    const seen = new Set<string>();
    for (const r of ranked) {
      if (picked.filter((p) => p.customer === r.customer).length >= perCustomer) break;
      const key = `${formatKey(r)}|${r.weekStart}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(r);
    }
    // A customer with only one distinct (format, week) still deserves one row.
    if (!picked.some((p) => p.customer === rs[0].customer) && ranked[0]) picked.push(ranked[0]);
  }
  return picked;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (!cmd || cmd === "help") {
    console.log("commands: census | plan --out <file> [--per-customer 3] | pin --in <file>");
    return;
  }
  requireEnv();

  if (cmd === "census") {
    census(await fetchAll());
    return;
  }

  if (cmd === "plan") {
    const out = arg("--out");
    if (!out) {
      console.error("plan requires --out <file>");
      process.exit(2);
    }
    const perCustomer = Number(arg("--per-customer") ?? 3);
    const rows = await fetchAll();
    const picked = plan(rows, perCustomer);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, JSON.stringify(picked, null, 2));
    console.log(`\nProposed ${picked.length} samples across ${new Set(picked.map((p) => p.customer)).size} customers.`);
    console.log(`${pad("id", 8)}${pad("customer", 26)}${pad("week", 12)}${pad("conf", 6)}${pad("expires", 9)}file`);
    for (const p of picked.sort((a, b) => a.customer.localeCompare(b.customer))) {
      console.log(
        pad(String(p.id), 8) +
          pad(p.customer, 26) +
          pad(p.weekStart, 12) +
          pad(p.confirmed ? "yes" : "NO", 6) +
          pad(`${daysUntil(p.expiresAt)}d`, 9) +
          p.fileName,
      );
    }
    console.log(`\nWrote ${out}. Nothing has been pinned — run \`pin --in ${out}\` to write.`);
    return;
  }

  if (cmd === "pin") {
    const inFile = arg("--in");
    if (!inFile) {
      console.error("pin requires --in <file>");
      process.exit(2);
    }
    const { readFile } = await import("node:fs/promises");
    const picked = JSON.parse(await readFile(inFile, "utf8")) as SampleRow[];
    console.log(`Pinning ${picked.length} samples…`);
    let ok = 0;
    for (const p of picked) {
      try {
        await api(`/admin/ai-extract-samples/${p.id}/pin`, {
          method: "PATCH",
          body: JSON.stringify({ pinned: true }),
        });
        ok++;
        console.log(`  pinned ${p.id}  ${p.customer}  ${p.fileName}`);
      } catch (err) {
        console.error(`  FAILED ${p.id}  ${(err as Error).message}`);
      }
    }
    console.log(`\n${ok}/${picked.length} pinned.`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(2);
}

await main();

export {};
