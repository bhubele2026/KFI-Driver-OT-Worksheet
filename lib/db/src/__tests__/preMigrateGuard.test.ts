import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePreMigrateGuard,
  DESTRUCTIVE_PUNCH_FIXUPS,
  PRE_MIGRATE_OPT_IN_ENV,
} from "../preMigrateGuard.js";

/**
 * Task #402 — covers the pre-migrate guard that protects production
 * from accidentally running the marker-gated DELETE FROM punches
 * fixups in `preMigrate.ts`.
 *
 * The guard is a pure function so we exercise every branch here without
 * touching Postgres. The fixup names list is asserted non-empty so a
 * future refactor that deletes the list (and silently disables the
 * guard) fails this test.
 */

test("DESTRUCTIVE_PUNCH_FIXUPS is non-empty so the guard actually guards something", () => {
  assert.ok(
    DESTRUCTIVE_PUNCH_FIXUPS.length > 0,
    "the list of guarded fixup names must not be empty",
  );
});

test("guard allows when no destructive fixups are scheduled, even in prod", () => {
  const decision = evaluatePreMigrateGuard(
    { nodeEnv: "production", optIn: undefined },
    ["seed clock_offsets with legacy Shuster +1h rows"],
  );
  assert.equal(decision.outcome, "allow");
});

test("guard allows destructive fixups in non-production environments", () => {
  for (const env of ["development", "test", undefined]) {
    const decision = evaluatePreMigrateGuard(
      { nodeEnv: env, optIn: undefined },
      [DESTRUCTIVE_PUNCH_FIXUPS[0]!],
    );
    assert.equal(
      decision.outcome,
      "allow",
      `NODE_ENV=${env ?? "unset"} should be allowed`,
    );
  }
});

test("guard REFUSES destructive fixups in production without opt-in", () => {
  const decision = evaluatePreMigrateGuard(
    { nodeEnv: "production", optIn: undefined },
    DESTRUCTIVE_PUNCH_FIXUPS,
  );
  assert.equal(decision.outcome, "refuse");
  assert.match(decision.reason, /production/);
  assert.match(decision.reason, new RegExp(PRE_MIGRATE_OPT_IN_ENV));
});

test("guard allows destructive fixups in production with KFI_ALLOW_BULK_PUNCH_DELETE=1", () => {
  const decision = evaluatePreMigrateGuard(
    { nodeEnv: "production", optIn: "1" },
    DESTRUCTIVE_PUNCH_FIXUPS,
  );
  assert.equal(decision.outcome, "allow");
  assert.match(decision.reason, /opt-in/);
});

test("guard refuses when the opt-in env is set to any non-'1' value in prod", () => {
  for (const value of ["true", "yes", "0", ""]) {
    const decision = evaluatePreMigrateGuard(
      { nodeEnv: "production", optIn: value },
      [DESTRUCTIVE_PUNCH_FIXUPS[0]!],
    );
    assert.equal(
      decision.outcome,
      "refuse",
      `optIn="${value}" must NOT count as bypass`,
    );
  }
});
