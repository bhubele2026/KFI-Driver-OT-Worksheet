/**
 * Static guards for the DB allow-list helper.
 *
 *  1. Unit-tests `assertE2ESafeDatabase` — the gate has to actually
 *     refuse prod-looking URLs and missing opt-ins, otherwise the
 *     whole point of task #361 evaporates.
 *  2. Scans every other file under `e2e/` for direct `pg` imports or
 *     `new Pool(...)` construction. If a new spec lands that bypasses
 *     `createE2EPool()`, this test fails and the suite never opens
 *     the unsafe connection. Only `_helpers/db.ts` is allowed to
 *     touch `pg` directly.
 */
import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2EDatabaseGuardError,
  assertE2ESafeDatabase,
} from "./_helpers/db";

test.describe("db helper allow-list", () => {
  test("rejects missing DATABASE_URL", () => {
    expect(() => assertE2ESafeDatabase(undefined, "1")).toThrow(
      E2EDatabaseGuardError,
    );
  });

  test("rejects missing KFI_E2E_ALLOW_DB opt-in", () => {
    expect(() =>
      assertE2ESafeDatabase(
        "postgresql://postgres:pw@helium/heliumdb",
        undefined,
      ),
    ).toThrow(/KFI_E2E_ALLOW_DB=1/);
  });

  test("rejects opt-in set to wrong value", () => {
    expect(() =>
      assertE2ESafeDatabase(
        "postgresql://postgres:pw@helium/heliumdb",
        "yes",
      ),
    ).toThrow(/KFI_E2E_ALLOW_DB=1/);
  });

  test("rejects a prod-looking host (not on allow-list)", () => {
    expect(() =>
      assertE2ESafeDatabase(
        "postgresql://postgres:pw@prod.example.com:5432/heliumdb",
        "1",
      ),
    ).toThrow(/not on the e2e allow-list/);
  });

  test("rejects an allowed host with a different database name", () => {
    expect(() =>
      assertE2ESafeDatabase(
        "postgresql://postgres:pw@helium/some_other_db",
        "1",
      ),
    ).toThrow(/not on the e2e allow-list/);
  });

  test("rejects an unparseable DATABASE_URL", () => {
    expect(() => assertE2ESafeDatabase("not a url", "1")).toThrow(
      /not a valid URL/,
    );
  });

  test("accepts the dev DB on the allow-list with opt-in set", () => {
    const got = assertE2ESafeDatabase(
      "postgresql://postgres:pw@helium/heliumdb?sslmode=disable",
      "1",
    );
    expect(got).toEqual({ host: "helium", database: "heliumdb" });
  });
});

test("no file under e2e/ touches pg directly outside the gated helper", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Exactly one file is allowed to import `pg` / construct `new Pool(...)`:
  // the gated helper itself. Everything else under `e2e/` — including any
  // future files added under `_helpers/` — must route through
  // `createE2EPool()` so the allow-list runs before a connection opens.
  // The guard spec is also exempt because the literal strings below
  // would otherwise self-trip the regex.
  const EXEMPT = new Set<string>(["_helpers/db.ts", "db-guard.spec.ts"]);
  const offenders: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const rel = path.relative(here, full).split(path.sep).join("/");
      if (EXEMPT.has(rel)) continue;
      const src = readFileSync(full, "utf8");
      if (/from\s+["']pg["']/.test(src) || /new\s+Pool\s*\(/.test(src)) {
        offenders.push(rel);
      }
    }
  }

  walk(here);
  expect(
    offenders,
    `These e2e files import 'pg' or construct 'new Pool(...)' directly. ` +
      `Use createE2EPool() from ./_helpers/db instead so the allow-list ` +
      `guard runs before any connection is opened.`,
  ).toEqual([]);
});
