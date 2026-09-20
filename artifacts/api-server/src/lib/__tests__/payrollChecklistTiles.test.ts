import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PAYROLL_CHECKLIST,
  PAYROLL_STAGE_KEYS,
  STAGE_TO_BOARD,
  BOARDS_WITHOUT_STEPS,
  SPINE_BOARD,
  boardForStage,
} from "../payrollChecklist.js";
import { TILE_KEYS, PAYROLL_TILE_KEYS } from "../tiles.js";

/**
 * The join between the workbook's stages and the board registry.
 *
 * ⚠️ THIS IS THE TEST THAT DID NOT EXIST. Four boards filtered the checklist
 * with their own tile key against a seed that used stage names, matched zero
 * steps, and shipped that way — the two vocabularies were never connected and
 * nothing checked. Every assertion here is a way that can happen again.
 */
describe("checklist stages map onto real boards", () => {
  it("every stage a seed uses is a declared stage key", () => {
    const declared = new Set<string>(PAYROLL_STAGE_KEYS);
    for (const s of PAYROLL_CHECKLIST) {
      assert.ok(declared.has(s.tile), `step ${s.key} has undeclared stage ${s.tile}`);
    }
  });

  it("every declared stage translates to a board", () => {
    for (const stage of PAYROLL_STAGE_KEYS) {
      assert.ok(STAGE_TO_BOARD[stage], `stage ${stage} maps to no board`);
    }
  });

  it("every board a stage maps to is a real tile in the registry", () => {
    for (const stage of PAYROLL_STAGE_KEYS) {
      const board = STAGE_TO_BOARD[stage];
      assert.ok(
        TILE_KEYS.includes(board),
        `stage ${stage} maps to ${board}, which is not a tile`,
      );
    }
  });

  it("every payroll board either receives steps or is exempt on purpose", () => {
    const reached = new Set(PAYROLL_CHECKLIST.map((s) => boardForStage(s.tile)));
    for (const board of PAYROLL_TILE_KEYS) {
      // The spine renders the whole checklist and is never filtered by stage.
      if (board === SPINE_BOARD) continue;
      if (BOARDS_WITHOUT_STEPS.has(board)) {
        assert.ok(
          !reached.has(board),
          `${board} is listed as step-free but steps reach it — update the list`,
        );
        continue;
      }
      assert.ok(
        reached.has(board),
        `${board} receives no checklist steps and is not on the exempt list — ` +
          "this is the bug that left four boards blank",
      );
    }
  });

  it("a stage name is never mistaken for a tile key", () => {
    // The original defect in one line: the seeds' own vocabulary must not
    // already look like board keys, or the bad comparison would 'work'
    // sometimes and hide the rest.
    for (const stage of PAYROLL_STAGE_KEYS) {
      if (STAGE_TO_BOARD[stage] === stage) continue; // payroll_batch is both, legitimately
      assert.ok(
        !TILE_KEYS.includes(stage),
        `stage ${stage} collides with a tile key of the same name`,
      );
    }
  });

  it("boardForStage refuses a stage it does not know", () => {
    assert.equal(boardForStage("not_a_stage"), null);
  });

  it("the four boards that were blank now receive steps", () => {
    const reached = new Set(PAYROLL_CHECKLIST.map((s) => boardForStage(s.tile)));
    for (const board of ["payroll_templates", "payroll_master", "payroll_rates"]) {
      assert.ok(reached.has(board), `${board} still receives no steps`);
    }
    // Holiday is the fourth. It genuinely owns no weekly step — it is driven
    // by a holiday date — so it is exempt rather than mapped, and that is
    // recorded rather than left to look like the same bug.
    assert.ok(BOARDS_WITHOUT_STEPS.has("payroll_holiday"));
  });
});
