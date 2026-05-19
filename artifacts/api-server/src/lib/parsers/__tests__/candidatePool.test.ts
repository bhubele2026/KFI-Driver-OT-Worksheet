import test from "node:test";
import assert from "node:assert/strict";

import { narrowDriverPool } from "../candidatePool.js";
import { topMatches } from "../fuzzy.js";

// Mirrors the candidate-pool construction in
// /weeks/:weekStart/extract-new-customer: the route narrows the active
// roster down to (punched-this-week ∪ saved-alias-target). Without that
// narrowing, the per-row dropdown surfaces every driver in the roster —
// including test fixtures and people who didn't work this week.
//
// We exercise the pool builder + topMatches together here because the
// route's correctness is the composition of the two — narrowing the
// pool and then ranking against it.

const roster = [
  { kfiId: "K-PUNCHED", name: "Alice Punched", customer: "Penda" },
  { kfiId: "K-UNPUNCHED", name: "Bob Unpunched", customer: "Penda" },
  { kfiId: "K-FIXTURE-A", name: "AAA Driver One", customer: "Test" },
  { kfiId: "K-FIXTURE-B", name: "BBB Driver Two", customer: "Test" },
  { kfiId: "K-SAVED", name: "Carol Saved", customer: "Penda" },
];

test("narrowDriverPool drops drivers that aren't in the allowed set", () => {
  const pool = narrowDriverPool(roster, new Set(["K-PUNCHED"]));
  assert.deepEqual(
    pool.map((d) => d.kfiId),
    ["K-PUNCHED"],
  );
});

test("narrowDriverPool keeps order from the input roster", () => {
  const pool = narrowDriverPool(
    roster,
    new Set(["K-SAVED", "K-PUNCHED"]),
  );
  // Filter, not reorder — caller controls ordering via the input array.
  assert.deepEqual(
    pool.map((d) => d.kfiId),
    ["K-PUNCHED", "K-SAVED"],
  );
});

test("narrowDriverPool returns empty when nothing is allowed", () => {
  assert.deepEqual(narrowDriverPool(roster, new Set()), []);
});

test("test-fixture drivers like 'AAA Driver One' do not appear when only Alice has Connecteam time", () => {
  // Simulate a normal week where exactly one driver punched in. The
  // dispatcher uploads a customer file naming "Alice P" — the topMatches
  // suggestions must not include AAA/BBB fixture drivers or unpunched
  // Bob, even though those would otherwise score above zero.
  const punched = new Set(["K-PUNCHED"]);
  const pool = narrowDriverPool(roster, punched);
  const matches = topMatches("Alice P", pool, 5);
  const ids = matches.map((m) => m.kfiId);
  assert.deepEqual(ids, ["K-PUNCHED"]);
  assert.ok(!ids.includes("K-FIXTURE-A"));
  assert.ok(!ids.includes("K-FIXTURE-B"));
  assert.ok(!ids.includes("K-UNPUNCHED"));
});

test("a saved-alias driver still appears in matches even when they have no Connecteam time this week", () => {
  // This is the regression the task specifically calls out: a prior
  // dispatcher decision stored in customer_name_aliases must survive
  // the "punched this week" filter. The route unions the saved-alias
  // kfiIds into the allowed set before narrowing, so the saved driver
  // is selectable even on a week they didn't punch in.
  const punched = new Set(["K-PUNCHED"]);
  const savedAliasKfiIds = new Set(["K-SAVED"]);
  const allowed = new Set([...punched, ...savedAliasKfiIds]);
  const pool = narrowDriverPool(roster, allowed);
  const matches = topMatches("Carol S", pool, 5);
  const ids = matches.map((m) => m.kfiId);
  // Carol is selectable…
  assert.ok(ids.includes("K-SAVED"), "saved-alias driver must be in matches");
  // …but the unpunched / fixture drivers are still filtered out.
  assert.ok(!ids.includes("K-UNPUNCHED"));
  assert.ok(!ids.includes("K-FIXTURE-A"));
  assert.ok(!ids.includes("K-FIXTURE-B"));
});
