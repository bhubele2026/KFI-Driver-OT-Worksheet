import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TILES,
  TILE_KEYS,
  PSEUDO_TILE_KEYS,
  GRANTABLE_KEYS,
  PAYROLL_GROUP_KEY,
  PAYROLL_TILE_KEYS,
  expandGrants,
  isEventTileKey,
  tileKeyForPath,
} from "../tiles.js";

describe("tile registry — path attribution", () => {
  // The Housing lesson: a board whose path the attribution function does not
  // know gets silently filed under `home` for its whole life. Walk the
  // registry so a new tile can never ship unmapped.
  it("resolves every tile's own href to its own key", () => {
    for (const t of TILES) {
      assert.equal(tileKeyForPath(t.href), t.key, `href ${t.href}`);
      assert.equal(tileKeyForPath(`${t.href}/deeper`), t.key, `subpath of ${t.href}`);
    }
  });

  it("longest href wins — a payroll sub-tile never resolves to the spine", () => {
    assert.equal(tileKeyForPath("/payroll-process/changes"), "payroll_changes");
    assert.equal(tileKeyForPath("/payroll-process"), "payroll_process");
  });
});

describe("tile registry — the settings retirement", () => {
  it("settings is no longer a tile: it lives behind the owner's gear", () => {
    assert.ok(!TILE_KEYS.includes("settings"));
    assert.ok(!GRANTABLE_KEYS.includes("settings"));
  });

  it("an orphaned settings grant row confers nothing", () => {
    // expandGrants leaves unknown keys in place; tilesForUser then filters
    // against TILE_KEYS — mirror that pipeline here.
    const conferred = expandGrants(["settings", "upload"]).filter((t) =>
      TILE_KEYS.includes(t),
    );
    assert.deepEqual(conferred.sort(), ["upload"]);
  });
});

describe("event tile keys — what the usage log accepts", () => {
  it("accepts every real tile and both pseudo-tiles", () => {
    for (const k of TILE_KEYS) assert.ok(isEventTileKey(k), k);
    for (const k of PSEUDO_TILE_KEYS) assert.ok(isEventTileKey(k), k);
  });

  it("pseudo-tiles are never grantable", () => {
    for (const k of PSEUDO_TILE_KEYS) {
      assert.ok(!TILE_KEYS.includes(k), k);
      assert.ok(!GRANTABLE_KEYS.includes(k), k);
    }
  });

  it("rejects junk and the group grant (a grant row, not a place)", () => {
    assert.ok(!isEventTileKey(""));
    assert.ok(!isEventTileKey("robots.txt"));
    assert.ok(!isEventTileKey(PAYROLL_GROUP_KEY));
  });
});

describe("group grant still expands", () => {
  it("payroll_all confers every payroll board", () => {
    const out = expandGrants([PAYROLL_GROUP_KEY]);
    for (const k of PAYROLL_TILE_KEYS) assert.ok(out.includes(k), k);
  });
});
