import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

// pg ≥8.16 emits a process-level "SECURITY WARNING" whenever sslmode rides in
// the URL — once per boot, and Sentry's console capture files it as an error
// (KFI-OT-API-1). Strip the param and keep the EXPLICIT ssl config instead:
// identical behavior, no warning. Upgrading to real cert verification is a
// deliberate future change, not a casual flip (dashboard convention).
const rawUrl = process.env.DATABASE_URL;
const wantsSsl = /sslmode=(require|prefer|verify-ca)/.test(rawUrl);
const cleanedUrl = rawUrl
  .replace(/sslmode=(require|prefer|verify-ca)&/, "")
  .replace(/[?&]sslmode=(require|prefer|verify-ca)$/, "");

// keepAlive + a 60s idle timeout keep the TLS session to Azure Postgres warm,
// so a page's burst of queries reuses one handshake instead of paying for a
// new one each time. Same tuning as the Financial Dashboard's pool (v149).
export const pool = new Pool({
  connectionString: cleanedUrl,
  ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  keepAlive: true,
  idleTimeoutMillis: 60_000,
});

export const db = drizzle(pool, { schema });
export { schema };
