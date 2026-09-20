import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..");
const cssRaw = readFileSync(join(src, "index.css"), "utf8");
/**
 * Comments stripped before anything is asserted. A note recording what a value
 * USED to be is not a value — the curve check failed on its own changelog
 * ("it used to hand-roll cubic-bezier(0.65, 0, 0.35, 1)") the first time it
 * ran, which would have taught the next person to delete the history rather
 * than keep it.
 */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The design gates.
 *
 * ⚠️ THESE EXIST BECAUSE READING THE SOURCE MISSED IT FOR MONTHS. The rule
 * "navy, grey, deep orange — nothing else" has been written at the top of
 * index.css since the port, and six payroll boards were still shipping
 * emerald, amber, sky and zinc the whole time. A rule nobody can run is a
 * comment. KFI-Housing pins its own the same way.
 */

/**
 * Words that share a prefix with a colour utility but are not colours —
 * `text-xs` is a size, `border-b` is an edge. Without these the check reports
 * "undeclared colour root xs", which teaches the reader to distrust it.
 */
const NOT_A_COLOUR = new Set([
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl",
  "b", "t", "l", "r", "x", "y", "s", "e",
  "left", "right", "center", "justify", "start", "end",
  "wrap", "nowrap", "ellipsis", "clip", "balance", "pretty",
  "display", "title", "body", "label", "micro",
  "opacity", "none", "auto", "solid", "dashed", "dotted", "hidden",
]);

/** The only colour names a payroll surface may carry. */
const ALLOWED = new Set([
  "brand", "ok", "warn", "bad", "neutral", "white", "black", "transparent",
  "current", "inherit", "foreground", "background", "border", "input", "ring",
  "card", "popover", "primary", "secondary", "muted", "accent", "destructive",
  "sidebar", "chart", "warning",
]);

/** Tailwind's category palettes. Any of these on a payroll board is a bug. */
const BANNED_FAMILIES = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose", "slate", "gray", "zinc", "stone",
];

/**
 * The payroll surfaces, and ONLY those.
 *
 * ⚠️ The driver-OT pages are deliberately out of scope. `bg-sky-500` there is
 * a LEGEND — it separates a Customer-sourced punch from a Connecteam one, and
 * a dispatcher scans that colour to decide which feed is wrong. Navy-on-navy
 * would erase the distinction. Orange there also carries two meanings at once
 * ("overtime exists", which is normal and good, and "a check failed"), and
 * splitting them is a product decision that lands on overtime figures, not a
 * colour swap. Widen this list only with that decision made.
 */
function payrollFiles(): string[] {
  const pages = readdirSync(join(src, "pages"))
    .filter((f) => f.startsWith("payroll-") && f.endsWith(".tsx"))
    .map((f) => join(src, "pages", f));
  const shared = ["check-panel.tsx", "tie-out-panel.tsx", "pay-date-picker.tsx"]
    .map((f) => join(src, "components", f));
  return [...pages, ...shared];
}

describe("payroll surfaces carry only the house palette", () => {
  it("no Tailwind category colour appears on any payroll board", () => {
    const offenders: string[] = [];
    for (const file of payrollFiles()) {
      const text = readFileSync(file, "utf8");
      for (const family of BANNED_FAMILIES) {
        const re = new RegExp(
          `(?:text|bg|border|ring|from|to|via|fill|stroke|divide|outline)-${family}-[0-9]{2,3}`,
          "g",
        );
        for (const hit of text.match(re) ?? []) {
          offenders.push(`${file.replace(src, "")}: ${hit}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `category colours on payroll surfaces:\n${offenders.join("\n")}`,
    );
  });

  it("every colour token the boards use is one the theme declares", () => {
    // Catches the other direction: a plausible-looking token that was never
    // defined compiles to nothing and fails silently on screen.
    const declared = new Set(
      [...css.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]),
    );
    for (const file of payrollFiles()) {
      const text = readFileSync(file, "utf8");
      const used = [...text.matchAll(/\b(?:text|bg|ring|border|divide)-([a-z]+)(?:-[a-z0-9]+)*\b/g)];
      for (const [, root] of used) {
        if (ALLOWED.has(root) || NOT_A_COLOUR.has(root)) continue;
        assert.ok(
          declared.has(root) || [...declared].some((d) => d.startsWith(`${root}-`)),
          `${file.replace(src, "")} uses undeclared colour root "${root}"`,
        );
      }
    }
  });
});

/**
 * ⚠️⚠️ THE BUILT BUNDLE IS NOT CLEAN YET, AND THAT IS KNOWN, NOT MISSED.
 *
 * KFI-Housing gates on an ALLOWLIST swept over its built CSS, because a source
 * blocklist passed clean while four `bg-emerald-50` utilities were still
 * shipping. The same sweep here still reports off-palette hexes:
 *
 *   #00bb7f emerald · #ff2357 rose · #f99c00 #fcbb00 #ffd236 amber ·
 *   #7b3306 #461901 — amber-900/950, which render as BROWN, and brown is
 *   banned outright.
 *
 * Every one of them is emitted for a DRIVER-OT surface, not a payroll board:
 * customer-preview-dialog, all-reviewed-splash, payroll-profile-card,
 * drivers-sidebar, presence-chip and the upload panels. Those are the last
 * un-ported surfaces in the app and they are excluded on purpose — the sky
 * blue in them is a punch-source legend and the orange carries two meanings at
 * once, so they need a product decision, not a colour swap.
 *
 * Enable a bundle-wide allowlist gate in the same commit that ports them.
 * Until then the source gate above covers everything that has actually been
 * ported, and this note is here so the remainder is a decision on the record
 * rather than something nobody noticed.
 */
describe("the motion dials are the ones Housing runs", () => {
  /**
   * ⚠️ PINNED TO KFI-HOUSING. These two apps are one system to the person
   * using them; the payroll app drifted for weeks at Housing's PRE-v122
   * numbers (460 / 45) while Housing ran 1.5× slower. If Housing re-paces,
   * change both and change this test — do not quietly let them diverge again.
   */
  const EXPECTED: Record<string, string> = {
    "--dur-press": "120ms",
    "--dur-in": "690ms",
    "--dur-travel": "1170ms",
    "--dur-page": "220ms",
    "--stagger": "68ms",
  };

  for (const [dial, value] of Object.entries(EXPECTED)) {
    it(`${dial} is ${value}`, () => {
      const m = css.match(new RegExp(`${dial}:\\s*([^;]+);`));
      assert.ok(m, `${dial} is not declared`);
      assert.equal(m![1].trim(), value);
    });
  }

  it("there are exactly two curves, and no third is hand-rolled", () => {
    const curves = new Set(
      [...css.matchAll(/cubic-bezier\([^)]+\)/g)].map((m) => m[0].replace(/\s+/g, "")),
    );
    assert.deepEqual(
      [...curves].sort(),
      ["cubic-bezier(0.16,1,0.3,1)", "cubic-bezier(0.45,0,0.55,1)"],
      "a third easing curve appeared — arrivals ride --ease-out, anything " +
        "travelling rides --ease-travel, and nothing hand-rolls its own",
    );
  });

  it("every dial is zeroed for someone who asked for no motion", () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
    assert.ok(block, "no reduced-motion block");
    for (const dial of Object.keys(EXPECTED)) {
      assert.ok(
        new RegExp(`${dial}:\\s*0ms`).test(block![1]),
        `${dial} keeps moving under prefers-reduced-motion`,
      );
    }
  });
});
