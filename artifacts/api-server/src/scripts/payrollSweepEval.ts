/**
 * Grade the sweep classifier against the 2026-09-16 hand run.
 *
 *   ANTHROPIC_API_KEY=… npx tsx src/scripts/payrollSweepEval.ts [--limit N]
 *
 * ⚠️ RUN THIS BEFORE TRUSTING THE NIGHTLY JOB. A model step that has never
 * been scored is a guess with a schema attached. The corpus is 59 real emails
 * and the 76 rows a human produced from them; this replays the emails through
 * the real prompt and reports where the model and the human disagree.
 *
 * It writes NOTHING — no database, no mailbox. Read-only by construction.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMessage, mapLimit, MAX_PARALLEL } from "../lib/payrollSweep/classify.js";
import type { MailBody } from "../lib/payrollSweep/graphMail.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "lib", "payrollSweep", "__fixtures__");

type Expected = {
  ref: string; src: string; payDate: string; employee?: string | null;
  changeType: string; amount?: number | null; hours?: number | null;
  needsDecision?: boolean;
};

function loadThread(key: string): MailBody {
  const raw = readFileSync(join(FIXTURES, "threads", `${key}.md`), "utf8");
  const [head, ...rest] = raw.split("\n---\n");
  const h: Record<string, string> = {};
  for (const line of head!.split("\n")) {
    const m = /^([A-Za-z]+): ?(.*)$/.exec(line);
    if (m) h[m[1]!] = m[2]!;
  }
  const list = (v?: string) => (v ?? "").split(";").map((x) => x.trim()).filter(Boolean);
  return {
    id: h.messageId ?? key,
    internetMessageId: h.internetMessageId ?? key,
    conversationId: h.conversationId ?? null,
    subject: h.subject ?? "",
    from: (h.from ?? "").replace(/^.*<([^>]+)>.*$/, "$1"),
    fromName: (h.from ?? "").replace(/\s*<.*$/, ""),
    to: (h.to ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    cc: [],
    receivedAt: h.received ?? "",
    sentAt: h.sent ?? null,
    categories: list(h.categories),
    hasAttachments: (h.attachments ?? "none") !== "none",
    parentFolderId: null,
    bodyPreview: (rest.join("\n---\n") ?? "").slice(0, 400),
    text: rest.join("\n---\n"),
    attachmentNames: list(h.attachments).filter((a) => a !== "none"),
  };
}

const norm = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  const expected: Expected[] = JSON.parse(
    readFileSync(join(FIXTURES, "actions-all.json"), "utf8"),
  );
  const bySrc = new Map<string, Expected[]>();
  for (const e of expected) {
    const l = bySrc.get(e.src) ?? [];
    l.push(e);
    bySrc.set(e.src, l);
  }

  const keys = readdirSync(join(FIXTURES, "threads"))
    .filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
    .slice(0, limit);

  console.log(`grading ${keys.length} threads against ${expected.length} human rows\n`);

  let humanRows = 0, modelRows = 0, matched = 0;
  const misses: string[] = [];
  const extras: string[] = [];

  const results = await mapLimit(keys, MAX_PARALLEL, async (key) => {
    const msg = loadThread(key);
    const out = await classifyMessage(msg, {
      openPayDate: "2026-09-18", todayIso: "2026-09-16",
    });
    return { key, rows: out.rows, note: out.note };
  });

  for (const { key, rows } of results) {
    const want = bySrc.get(key) ?? [];
    humanRows += want.length;
    modelRows += rows.length;
    const unused = [...rows];
    for (const w of want) {
      // A match is same person + same change-type family + same money/hours.
      const i = unused.findIndex((r) =>
        norm(r.employee) === norm(w.employee)
        && norm(r.changeType).split(" ")[0] === norm(w.changeType).split(" ")[0]
        && (w.amount ?? null) === (r.amount ?? null)
        && (w.hours ?? null) === (r.hours ?? null));
      if (i >= 0) { matched++; unused.splice(i, 1); }
      else misses.push(`${key} ${w.ref}: ${w.employee ?? "?"} / ${w.changeType} / amt=${w.amount ?? "-"} hrs=${w.hours ?? "-"}`);
    }
    for (const u of unused) {
      extras.push(`${key}: ${u.employee ?? "?"} / ${u.changeType} / amt=${u.amount ?? "-"} — ${String(u.action).slice(0, 80)}`);
    }
  }

  const recall = humanRows ? (matched / humanRows) * 100 : 0;
  const precision = modelRows ? (matched / modelRows) * 100 : 0;
  console.log(`human rows : ${humanRows}`);
  console.log(`model rows : ${modelRows}`);
  console.log(`matched    : ${matched}`);
  console.log(`recall     : ${recall.toFixed(1)}%   (of the human's rows, how many did it find)`);
  console.log(`precision  : ${precision.toFixed(1)}%   (of its rows, how many the human also had)`);
  console.log(`\n--- MISSED (${misses.length}) — the number that matters most ---`);
  for (const m of misses) console.log("  " + m);
  console.log(`\n--- EXTRA (${extras.length}) — review these by hand before judging them wrong ---`);
  for (const e of extras.slice(0, 40)) console.log("  " + e);

  // ⚠️ Deliberately no pass/fail threshold. A human reads the misses and
  // decides; a green tick here would be the exact false comfort this script
  // exists to prevent.
}

void main();
