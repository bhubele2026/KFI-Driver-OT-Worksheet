import { createHash } from "node:crypto";
import { normalizeChangeType, type ChangeType } from "./payrollChangeTypes.js";

/**
 * Merging a fresh sweep into the change ledger.
 *
 * ⚠️ THE MERGE MUST BE IDEMPOTENT AND MUST NEVER CLOBBER A HUMAN'S WORK. This
 * runs every morning against a mailbox that keeps moving, so the same action is
 * seen many times. A rebuild that wipes a processor's check-offs and notes is
 * worse than having no tool at all — they would stop trusting it in one day and
 * go back to the workbook.
 *
 * So: the sweep owns the FACTS (who, what, how much, from which email) and the
 * human owns the PROGRESS (the four verification counts, notes, and whether it
 * needs a decision). A re-sweep updates the first and carries the second.
 */

/** Fold a name so "Torres, Angela" and "torres,  angela" are one person. */
export function normalizePersonKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export type RowKeyParts = {
  /** Thread id — the stable spine of a corrected conversation. */
  conversationId?: string | null;
  employee?: string | null;
  changeType: string;
  /** Retro rows belong to a DIFFERENT week and are their own action. */
  weekEnding?: string | null;
};

/**
 * The identity of an action row.
 *
 * Week ending is part of the key on purpose: Fontaine's Juan had OT booked to
 * both the current week and the prior one, and those are two separate entries a
 * processor must key separately. Collapsing them loses the retro.
 */
export function rowKeyFor(p: RowKeyParts): string {
  const canonical = [
    p.conversationId ?? "",
    normalizePersonKey(p.employee),
    normalizeChangeType(p.changeType),
    p.weekEnding ?? "",
  ].join("|");
  return createHash("sha1").update(canonical).digest("hex").slice(0, 20);
}

/** What a sweep produces — facts only. */
export type SweptRow = {
  rowKey: string;
  customer?: string | null;
  employee?: string | null;
  peopleCount?: number;
  route?: string | null;
  changeType: ChangeType;
  changeTypeRaw?: string | null;
  amount?: number | null;
  hours?: number | null;
  weekEnding?: string | null;
  effectiveDate?: string | null;
  isRetro?: boolean;
  action: string;
  supersedes?: string | null;
  pairedWithRowKey?: string | null;
  requestedBy?: string | null;
  approvedBy?: string | null;
  category?: string | null;
  conversationId?: string | null;
  /** Graph id of THE message that drove the row — not just the thread. */
  sourceMessageId?: string | null;
  sourceRef?: string | null;
  sourceReceivedAt?: Date | null;
  needsDecision?: boolean;
  decisionQuestion?: string | null;
  decisionOwner?: string | null;
};

/** What is already stored — facts plus the human's progress. */
export type StoredRow = SweptRow & {
  enteredZenople: number;
  verifiedTs: number;
  verifiedPas: number;
  documentationSaved: number;
  notes?: string | null;
  sweepState?: string;
};

/** Fields the human owns. A sweep never writes these. */
const HUMAN_OWNED = [
  "enteredZenople", "verifiedTs", "verifiedPas", "documentationSaved", "notes",
] as const;

/** Fields worth announcing when a re-sweep changes them. */
const MATERIAL = [
  "amount", "hours", "effectiveDate", "weekEnding", "action", "route",
  "changeType", "peopleCount",
] as const;

export type MergeOutcome = {
  row: StoredRow;
  state: "new" | "changed" | "unchanged";
  /** Human-readable "was X, now Y" for each material change. */
  changes: string[];
};

/**
 * Merge one swept row over its stored counterpart.
 *
 * Returns the row to persist plus what actually moved, so the board can show
 * "CHANGED — amount was 8.00" rather than silently replacing a number a
 * processor may already have keyed.
 */
export function mergeRow(swept: SweptRow, stored: StoredRow | undefined): MergeOutcome {
  if (!stored) {
    return {
      row: {
        ...swept,
        enteredZenople: 0, verifiedTs: 0, verifiedPas: 0, documentationSaved: 0,
        notes: null, sweepState: "new",
      },
      state: "new",
      changes: [],
    };
  }

  const changes: string[] = [];
  for (const f of MATERIAL) {
    const before = stored[f];
    const after = swept[f];
    if (after === undefined) continue;
    if (before !== after && !(before == null && after == null)) {
      changes.push(`${f} was ${before ?? "blank"}, now ${after ?? "blank"}`);
    }
  }

  // Facts from the sweep, progress from the stored row. Never the other way.
  //
  // ⚠️ Spreading `{ ...stored, ...swept }` is WRONG: a key present-but-undefined
  // on the swept row overwrites a real stored value with undefined, so a sweep
  // that simply did not mention an amount would blank it. Copy only what the
  // sweep actually supplied.
  const merged: StoredRow = { ...stored };
  for (const [k, v] of Object.entries(swept)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  for (const f of HUMAN_OWNED) {
    (merged as Record<string, unknown>)[f] = stored[f];
  }
  merged.sweepState = changes.length ? "changed" : "unchanged";

  return { row: merged, state: changes.length ? "changed" : "unchanged", changes };
}

/**
 * Merge a whole sweep.
 *
 * ⚠️ Rows that VANISH from the sweep are kept, not deleted. Mail gets filed,
 * archived and re-threaded; a row disappearing from today's window does not
 * mean the action stopped being required, and deleting it would quietly drop
 * work a processor had already started.
 */
export function mergeSweep(
  swept: SweptRow[],
  stored: StoredRow[],
): { rows: StoredRow[]; created: number; changed: number; carried: number; report: string[] } {
  const byKey = new Map(stored.map((r) => [r.rowKey, r]));
  const seen = new Set<string>();
  const rows: StoredRow[] = [];
  const report: string[] = [];
  let created = 0;
  let changed = 0;

  for (const s of swept) {
    seen.add(s.rowKey);
    const out = mergeRow(s, byKey.get(s.rowKey));
    rows.push(out.row);
    if (out.state === "new") {
      created++;
      report.push(`NEW ${s.employee ?? "?"} — ${s.action}`);
    } else if (out.state === "changed") {
      changed++;
      report.push(`CHANGED ${s.employee ?? "?"} — ${out.changes.join("; ")}`);
    }
  }

  const carriedRows = stored.filter((r) => !seen.has(r.rowKey));
  for (const r of carriedRows) rows.push({ ...r, sweepState: "unchanged" });

  return { rows, created, changed, carried: carriedRows.length, report };
}

/**
 * Guard for an unattended run.
 *
 * ⚠️ Zero swept rows is indistinguishable from a dead mail connector, and the
 * M365 token HAS died mid-run before. An empty sweep must never be written over
 * a ledger that has rows — keep what is there, and fail loudly instead.
 */
export function sweepIsSafeToApply(
  sweptCount: number,
  storedCount: number,
): { ok: true } | { ok: false; reason: string } {
  if (sweptCount === 0 && storedCount > 0) {
    return {
      ok: false,
      reason:
        `sweep returned 0 rows while ${storedCount} are stored — refusing to apply. ` +
        `An empty result and a broken connector look identical; keeping the previous ledger.`,
    };
  }
  return { ok: true };
}
