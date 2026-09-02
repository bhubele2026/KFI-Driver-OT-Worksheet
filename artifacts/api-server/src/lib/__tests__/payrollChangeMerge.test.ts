import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rowKeyFor, normalizePersonKey, mergeRow, mergeSweep, sweepIsSafeToApply,
  type SweptRow, type StoredRow,
} from "../payrollChangeMerge";

const swept = (o: Partial<SweptRow> = {}): SweptRow => ({
  rowKey: "k1", employee: "Torres, Angela", changeType: "MN ESST",
  action: "Enter 10.00 hrs MN-ESST", weekEnding: "2026-08-22",
  conversationId: "conv-1", amount: null, hours: 10, ...o,
});

const stored = (o: Partial<StoredRow> = {}): StoredRow => ({
  ...swept(), enteredZenople: 0, verifiedTs: 0, verifiedPas: 0,
  documentationSaved: 0, notes: null, ...o,
});

describe("rowKeyFor", () => {
  it("is stable across spacing and casing of a name", () => {
    assert.equal(
      rowKeyFor({ conversationId: "c", employee: "Torres, Angela", changeType: "MN ESST" }),
      rowKeyFor({ conversationId: "c", employee: "torres,   ANGELA", changeType: "MN ESST" }),
    );
  });

  it("is stable across the ledger's spelling drift for a type", () => {
    assert.equal(
      rowKeyFor({ conversationId: "c", employee: "X", changeType: "Housing Deductions Pro rate" }),
      rowKeyFor({ conversationId: "c", employee: "X", changeType: "Housing Deducations pro rate" }),
    );
  });

  it("SEPARATES the retro week from the current week", () => {
    // Fontaine's Juan had OT on both weeks. They are two entries a processor
    // must key separately; one key would lose the retro.
    const cur = rowKeyFor({ conversationId: "c", employee: "Juan", changeType: "Retro Pay", weekEnding: "2026-08-22" });
    const prior = rowKeyFor({ conversationId: "c", employee: "Juan", changeType: "Retro Pay", weekEnding: "2026-08-15" });
    assert.notEqual(cur, prior);
  });

  it("separates two people in one thread", () => {
    assert.notEqual(
      rowKeyFor({ conversationId: "c", employee: "Galvin", changeType: "MN ESST" }),
      rowKeyFor({ conversationId: "c", employee: "Gutierrez", changeType: "MN ESST" }),
    );
  });

  it("normalizePersonKey collapses punctuation", () => {
    assert.equal(normalizePersonKey("Rangel , Obdulia"), "rangel obdulia");
  });
});

describe("mergeRow — the sweep owns facts, the human owns progress", () => {
  it("marks an unseen row new with zeroed progress", () => {
    const out = mergeRow(swept(), undefined);
    assert.equal(out.state, "new");
    assert.equal(out.row.enteredZenople, 0);
  });

  it("CARRIES the verification counts and notes across a re-sweep", () => {
    // This is the whole point. Wiping these once and the tool is abandoned.
    const prior = stored({ enteredZenople: 2, verifiedPas: 1, notes: "asked Lino" });
    const out = mergeRow(swept(), prior);
    assert.equal(out.row.enteredZenople, 2);
    assert.equal(out.row.verifiedPas, 1);
    assert.equal(out.row.notes, "asked Lino");
  });

  it("updates the facts while carrying the progress", () => {
    const prior = stored({ hours: 8, enteredZenople: 1, notes: "keep me" });
    const out = mergeRow(swept({ hours: 10 }), prior);
    assert.equal(out.row.hours, 10);
    assert.equal(out.row.enteredZenople, 1);
    assert.equal(out.row.notes, "keep me");
  });

  it("reports WHAT changed, so a keyed number is never silently replaced", () => {
    // The real case: Galvin and Gutierrez requested at 8 hrs, corrected to 10.
    const out = mergeRow(swept({ hours: 10 }), stored({ hours: 8 }));
    assert.equal(out.state, "changed");
    assert.ok(out.changes.some((c) => c.includes("hours was 8, now 10")), out.changes.join());
  });

  it("calls an identical re-sweep unchanged", () => {
    assert.equal(mergeRow(swept(), stored()).state, "unchanged");
  });

  it("does not report a field the sweep did not supply", () => {
    const out = mergeRow(swept({ amount: undefined }), stored({ amount: 50 }));
    assert.equal(out.row.amount, 50);
    assert.equal(out.state, "unchanged");
  });
});

describe("mergeSweep", () => {
  it("counts new, changed and carried separately", () => {
    const priorRows = [
      stored({ rowKey: "a", hours: 8 }),
      stored({ rowKey: "gone", employee: "Filed Away", enteredZenople: 1 }),
    ];
    const out = mergeSweep(
      [swept({ rowKey: "a", hours: 10 }), swept({ rowKey: "b", employee: "New Person" })],
      priorRows,
    );
    assert.equal(out.created, 1);
    assert.equal(out.changed, 1);
    assert.equal(out.carried, 1);
  });

  it("KEEPS a row that vanished from the sweep", () => {
    // Mail gets filed and re-threaded. A row leaving today's window does not
    // mean the action stopped being required.
    const out = mergeSweep([], [stored({ rowKey: "gone", enteredZenople: 1 })]);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.enteredZenople, 1);
  });

  it("produces a readable report", () => {
    const out = mergeSweep([swept({ hours: 10 })], [stored({ hours: 8 })]);
    assert.match(out.report[0]!, /^CHANGED/);
  });
});

describe("sweepIsSafeToApply — the unattended-run guard", () => {
  it("REFUSES an empty sweep over a populated ledger", () => {
    // Zero rows and a dead M365 token look identical, and the token has died
    // mid-run before.
    const v = sweepIsSafeToApply(0, 12);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /refusing to apply/);
  });

  it("allows an empty sweep when nothing is stored yet", () => {
    assert.equal(sweepIsSafeToApply(0, 0).ok, true);
  });

  it("allows a normal sweep", () => {
    assert.equal(sweepIsSafeToApply(12, 12).ok, true);
  });
});

describe("source email provenance — a fact the sweep may backfill", () => {
  it("a re-sweep ADDS sourceMessageId to a row that predates it", () => {
    // Rows minted before the sweeps carried message ids have only the thread;
    // the Create-PDF flow lives on the exact message, so the link must be able
    // to arrive late.
    const out = mergeRow(
      swept({ sourceMessageId: "msg-9" }),
      stored({ sourceMessageId: undefined }),
    );
    assert.equal(out.row.sourceMessageId, "msg-9");
  });

  it("a sweep that omits sourceMessageId leaves the stored one standing", () => {
    const out = mergeRow(swept(), stored({ sourceMessageId: "msg-9" }));
    assert.equal(out.row.sourceMessageId, "msg-9");
  });

  it("provenance alone does not mark the row changed — nothing to re-key", () => {
    const out = mergeRow(swept({ sourceMessageId: "msg-9" }), stored());
    assert.equal(out.state, "unchanged");
  });
});
