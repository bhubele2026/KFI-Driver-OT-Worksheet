import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = dirname(__filename_);
const SRC = resolve(__dirname_, "..", "src");
const I18N = resolve(SRC, "i18n");

function flatten(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const x of flatten(v as Record<string, unknown>, key)) out.add(x);
    } else {
      out.add(key);
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "ui" || entry === "i18n" || entry === "__tests__") continue;
      walk(full, acc);
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const KEY_RE = /\bt\(\s*(["'`])([a-zA-Z0-9_.]+(?:_one|_other|_zero|_few|_many)?)\1/g;

function collectKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const txt = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(txt)) !== null) {
      const key = m[2];
      const arr = found.get(key) ?? [];
      arr.push(file);
      found.set(key, arr);
    }
  }
  return found;
}

const enJson = JSON.parse(
  readFileSync(join(I18N, "en.json"), "utf8"),
) as Record<string, unknown>;
const esJson = JSON.parse(
  readFileSync(join(I18N, "es.json"), "utf8"),
) as Record<string, unknown>;
const esStatus = JSON.parse(
  readFileSync(join(I18N, "es.status.json"), "utf8"),
) as { machineTranslated: string[] };

const enKeys = flatten(enJson);
const esKeys = flatten(esJson);

test.describe("i18n key coverage", () => {
  test("every t(\"...\") key referenced in src/ exists in both en and es", () => {
    const refs = collectKeys();
    const missing: { key: string; locale: "en" | "es"; sample: string }[] = [];
    const pluralSuffixes = ["_one", "_other", "_zero", "_few", "_two", "_many"];
    function has(set: Set<string>, key: string): boolean {
      if (set.has(key)) return true;
      const stripped = key.replace(/_(one|other|zero|few|two|many)$/, "");
      if (stripped !== key && set.has(stripped)) return true;
      for (const s of pluralSuffixes) if (set.has(stripped + s)) return true;
      return false;
    }
    for (const [key, files] of refs) {
      if (!has(enKeys, key)) {
        missing.push({ key, locale: "en", sample: files[0] });
      }
      if (!has(esKeys, key)) {
        missing.push({ key, locale: "es", sample: files[0] });
      }
    }
    expect(missing, JSON.stringify(missing, null, 2)).toEqual([]);
  });

  test("en and es bundles have identical key sets", () => {
    const onlyEn = [...enKeys].filter((k) => !esKeys.has(k)).sort();
    const onlyEs = [...esKeys].filter((k) => !enKeys.has(k)).sort();
    expect({ onlyEn, onlyEs }).toEqual({ onlyEn: [], onlyEs: [] });
  });

  test("es.status.json entries all exist in es bundle", () => {
    const stale = esStatus.machineTranslated.filter((k) => !esKeys.has(k));
    expect(stale).toEqual([]);
  });

  test("static UI chrome shows no English-only words in es bundle", () => {
    const denylist = [
      "Save",
      "Cancel",
      "Delete",
      "Reset",
      "Driver Hrs",
      "Cust Hrs",
      "Reviewed",
      "Reupload",
      "Upload customer file",
      "Hidden notes",
      "Recent activity",
    ];
    const flat: Record<string, string> = {};
    function visit(obj: Record<string, unknown>, prefix = "") {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          visit(v as Record<string, unknown>, key);
        } else if (typeof v === "string") {
          flat[key] = v;
        }
      }
    }
    visit(esJson);
    const offenders: { key: string; value: string; word: string }[] = [];
    for (const [key, value] of Object.entries(flat)) {
      for (const word of denylist) {
        const re = new RegExp(`\\b${word}\\b`);
        if (re.test(value)) {
          offenders.push({ key, value, word });
        }
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });
});
