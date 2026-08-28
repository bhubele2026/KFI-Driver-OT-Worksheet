import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { classifyArtifact } from "../payrollArtifactKinds";
import { classify as bridgeClassify } from "../../../../../scripts/src/payroll-bridge";

/**
 * The bridge carries its own copy of the classifier so it can run from a plain
 * `tsx` with no workspace build — a stale `dist/` on Brad's Mac would be worse
 * than a duplicate. This is the test that makes the duplicate safe: the two
 * must agree, on the real tree, on every file.
 */

const ROOT = path.join(
  os.homedir(),
  "Library/CloudStorage/OneDrive-KrugerFamilyIndustries/KFI Payroll - Associate-External Payroll",
);

const SAMPLES: Array<[string, string]> = [
  ["CS Expert Pay PD 08.28.2026.csv", "Expert Pay"],
  ["random notes.xlsx", "Expert Pay"],
  ["Master External FOR IMPORT PD 08.28.2026.xlsx", ""],
  ["Master External FOR IMPORT without driver pay units PD 08.28.2026.xlsx", ""],
  ["Master External PD 08.28.2026_20260821 original download.csv", ""],
  ["KFIWeeklyTimesheetExport Penda Import PD 08.28.2026.xlsx", ""],
  ["MN ESST LSI Myers Email from Ruby.pdf", "Documentation"],
  ["3.1.1Troubleshooting Transaction batches incomplete.docx", ""],
  ["2.1 Penda and Trienda Timesheet Processing.mp4", ""],
  ["Task List For tracking Rapid Deactivated cards 08.28.2026.xlsx", ""],
  ["Holiday Pay FOR IMPORT PD 06.05.2026.csv", "Holiday"],
  ["Holiday Pay Eligibility file PD 06.05.2026.xlsx", "Holiday"],
  ["Penda and Trienda Payroll Cost Calculator TY.xlsx", ""],
  ["Loop paragraph.loop", ""],
];

describe("bridge classifier parity", () => {
  it("agrees with the server on the tricky cases", () => {
    for (const [name, folder] of SAMPLES) {
      const server = classifyArtifact(name, folder);
      const bridge = bridgeClassify(name, folder);
      assert.equal(bridge.kind, server.kind, `${folder}/${name}`);
      assert.equal(bridge.sensitive, server.sensitive, `sensitivity for ${folder}/${name}`);
    }
  });

  it("agrees on EVERY file in the real tree", (t) => {
    if (!fs.existsSync(ROOT)) {
      // The tree is Brad's OneDrive; CI will not have it. Skipping is honest,
      // silently passing would not be.
      t.skip("payroll root not present on this machine");
      return;
    }
    let checked = 0;
    const mismatches: string[] = [];
    const walk = (dir: string, sub: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".DS_Store") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, e.name); continue; }
        checked++;
        const a = classifyArtifact(e.name, sub);
        const b = bridgeClassify(e.name, sub);
        if (a.kind !== b.kind || a.sensitive !== b.sensitive) {
          mismatches.push(`${sub}/${e.name}: server=${a.kind}/${a.sensitive} bridge=${b.kind}/${b.sensitive}`);
        }
      }
    };
    walk(ROOT, "");
    assert.ok(checked > 3000, `expected the whole tree, saw ${checked}`);
    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} of ${checked} disagree`);
  });

  it("never lets the bridge under-report sensitivity", () => {
    // The asymmetric risk: the bridge calling something safe that the server
    // calls sensitive would push unmasked SSNs. The reverse is only noise.
    for (const [name, folder] of SAMPLES) {
      if (classifyArtifact(name, folder).sensitive) {
        assert.equal(bridgeClassify(name, folder).sensitive, true, `${folder}/${name}`);
      }
    }
  });
});
