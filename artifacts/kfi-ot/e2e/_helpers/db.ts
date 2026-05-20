/**
 * Hard gate around DB access from the kfi-ot e2e suite.
 *
 * The self-onboarding specs (and many others) write directly to whatever
 * Postgres `DATABASE_URL` points at. Twice now we've discovered that
 * synthetic e2e fixtures landed in the production database because a
 * misconfigured shell or CI step ran the suite against prod. This helper
 * is the structural fix: every e2e spec must obtain its `Pool` from
 * `createE2EPool()`, which refuses to open a connection unless both:
 *
 *   1. `KFI_E2E_ALLOW_DB=1` is explicitly set (belt — opt-in flag that
 *      the prod environment must never set), and
 *   2. The URL's host AND database name are on the e2e allow-list
 *      below (suspenders — defends against the opt-in being set by
 *      accident in a non-dev env).
 *
 * Anything not on the allow-list is treated as prod. To add a new dev
 * environment, extend `ALLOWED_HOSTS` / `ALLOWED_DB_NAMES` here.
 *
 * Direct `new Pool(...)` in spec files is forbidden — the
 * `e2e-no-direct-pool` spec in this directory scans the rest of `e2e/`
 * and fails the suite if any other file imports `pg` or constructs a
 * `Pool` directly. Use `createE2EPool()` instead.
 */
import { Pool } from "pg";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "helium",
  "localhost",
  "127.0.0.1",
]);

const ALLOWED_DB_NAMES: ReadonlySet<string> = new Set(["heliumdb"]);

export class E2EDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2EDatabaseGuardError";
  }
}

export interface ParsedDatabaseTarget {
  host: string;
  database: string;
}

export function assertE2ESafeDatabase(
  databaseUrl: string | undefined,
  optIn: string | undefined,
): ParsedDatabaseTarget {
  if (!databaseUrl) {
    throw new E2EDatabaseGuardError(
      "DATABASE_URL must be set to run the kfi-ot e2e suite.",
    );
  }
  if (optIn !== "1") {
    throw new E2EDatabaseGuardError(
      "Refusing to open a database connection for e2e tests: " +
        "KFI_E2E_ALLOW_DB=1 is required. Set it only when DATABASE_URL " +
        "points at a disposable dev database — never set it in the prod " +
        "environment. See replit.md > Run & Operate.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new E2EDatabaseGuardError(
      `DATABASE_URL is not a valid URL and cannot be matched against the e2e allow-list.`,
    );
  }
  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, "");
  if (!ALLOWED_HOSTS.has(host) || !ALLOWED_DB_NAMES.has(database)) {
    throw new E2EDatabaseGuardError(
      `Refusing to open a database connection for e2e tests: DATABASE_URL ` +
        `host=${host || "(empty)"} database=${database || "(empty)"} is not on ` +
        `the e2e allow-list (allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}; ` +
        `allowed databases: ${[...ALLOWED_DB_NAMES].join(", ")}). Point ` +
        `DATABASE_URL at the Replit dev database before running e2e tests.`,
    );
  }
  return { host, database };
}

export function createE2EPool(): Pool {
  assertE2ESafeDatabase(process.env.DATABASE_URL, process.env.KFI_E2E_ALLOW_DB);
  return new Pool({ connectionString: process.env.DATABASE_URL });
}
