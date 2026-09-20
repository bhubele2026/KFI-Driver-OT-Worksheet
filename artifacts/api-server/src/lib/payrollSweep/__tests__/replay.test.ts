import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRows, type BuiltRow, type ClassifiedAction, type SourceFacts,
} from "../buildRows";

/**
 * THE REGRESSION CORPUS.
 *
 * 59 real payroll emails and the 76 action rows a human produced from them on
 * 2026-09-16, replayed through the server's builder. This is the only ground
 * truth this feature has, and it is NOT regenerable: Tiana refiled several of
 * those messages while the sweep ran, which changed their Graph ids, so some
 * could not be re-fetched even with a working credential. If these fixtures are
 * ever deleted, the honest thing to say about the builder is that it is
 * untested.
 *
 * The classifier's own accuracy is a separate question — a graded replay, not a
 * unit test, because a model's output is a distribution and this file must stay
 * deterministic.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "__fixtures__");

type FixtureAction = ClassifiedAction & { src: string; sourcePeriod?: string };

function threadHeader(key: string): Record<string, string> {
  const raw = readFileSync(join(FIXTURES, "threads", `${key}.md`), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (line === "---") break;
    const m = /^([A-Za-z]+): ?(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const actions: FixtureAction[] = JSON.parse(
  readFileSync(join(FIXTURES, "actions-all.json"), "utf8"),
);

/** The run happened on this day; the open period was PD 09.18. */
const TODAY = "2026-09-16";

function replay(): { built: BuiltRow[]; rejected: Array<{ ref: string; detail: string }> } {
  const bySrc = new Map<string, FixtureAction[]>();
  for (const a of actions) {
    const list = bySrc.get(a.src) ?? [];
    list.push(a);
    bySrc.set(a.src, list);
  }
  const built: BuiltRow[] = [];
  const rejected: Array<{ ref: string; detail: string }> = [];
  for (const [src, group] of bySrc) {
    const h = threadHeader(src);
    const facts: SourceFacts = {
      conversationId: h.conversationId ?? null,
      sourceMessageId: h.messageId ?? `missing:${src}`,
      sourceRef: h.subject ?? "",
      sourceReceivedAt: h.received ? new Date(h.received) : null,
      category: (h.categories ?? "").split(";").map((c) => c.trim()).filter(Boolean)[0] ?? null,
    };
    const r = buildRows(group, facts, { todayIso: TODAY, closedPayDates: new Set() });
    built.push(...r.built);
    rejected.push(...r.rejected.map((x) => ({ ref: x.ref, detail: x.detail })));
  }
  return { built, rejected };
}

describe("replay of the 2026-09-16 hand run", () => {
  const { built, rejected } = replay();

  it("has the corpus on disk", () => {
    assert.equal(actions.length, 76);
    assert.equal(
      readdirSync(join(FIXTURES, "threads")).filter((f) => f.endsWith(".md")).length,
      59,
    );
  });

  it("rebuilds every row, rejecting none", () => {
    // A rejection here means the builder disagrees with a row a human checked
    // and posted. Read the detail before "fixing" the fixture.
    assert.deepEqual(rejected.map((r) => `${r.ref}: ${r.detail}`), []);
    assert.equal(built.length, 76);
  });

  it("gives every row a route — nothing lands in 'Needs a route'", () => {
    assert.deepEqual(built.filter((b) => !b.row.route).map((b) => b.ref), []);
  });

  it("keeps row keys unique inside each period", () => {
    const seen = new Set<string>();
    for (const b of built) {
      const k = `${b.payDate}|${b.row.rowKey}`;
      assert.equal(seen.has(k), false, `duplicate row key for ${b.ref}`);
      seen.add(k);
    }
  });

  it("routes terminations to Ops", () => {
    const terms = built.filter((b) => b.row.changeType === "Termination");
    assert.ok(terms.length > 0);
    for (const t of terms) assert.equal(t.row.route, "Ops");
  });

  it("carries the eight decisions as decisions, not actions", () => {
    const decisions = built.filter((b) => b.row.needsDecision === true);
    assert.equal(decisions.length, 8);
    for (const d of decisions) assert.notEqual(String(d.row.decisionQuestion ?? ""), "");
  });

  it("marks the PD 09.11 misses retro and prefixes them", () => {
    const misses = actions.filter((a) => a.sourcePeriod === "2026-09-11");
    assert.equal(misses.length, 7);
    for (const m of misses) {
      const row = built.find((b) => b.ref === m.ref);
      assert.ok(row, `${m.ref} should have been built`);
      assert.equal(row!.row.isRetro, true);
      assert.match(row!.row.action, /^RETRO — /);
    }
  });

  it("splits the three pay dates the way the run did", () => {
    const byDate: Record<string, number> = {};
    for (const b of built) byDate[b.payDate] = (byDate[b.payDate] ?? 0) + 1;
    assert.deepEqual(byDate, { "2026-09-18": 62, "2026-09-25": 13, "2026-10-02": 1 });
  });
});

describe("closed periods are never repopulated", () => {
  it("retargets a closed period's row onto the open one as retro", () => {
    const a: ClassifiedAction = {
      ref: "x", payDate: "2026-09-11", employee: "Ana Navarro",
      changeType: "Housing Deductions Stop", weekEnding: "2026-09-05",
      action: "Stop housing eff 9/11",
    };
    const facts: SourceFacts = {
      conversationId: "c", sourceMessageId: "m", sourceRef: "s",
      sourceReceivedAt: null, category: null,
    };
    const { built } = buildRows([a], facts, {
      todayIso: TODAY, closedPayDates: new Set(["2026-09-11"]),
    });
    assert.equal(built.length, 1);
    assert.equal(built[0]!.payDate, "2026-09-18");
    assert.equal(built[0]!.row.isRetro, true);
    assert.match(built[0]!.row.action, /^RETRO — /);
  });
});
