import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

// keepAlive + a 60s idle timeout keep the TLS session to Azure Postgres warm,
// so a page's burst of queries reuses one handshake instead of paying for a
// new one each time. Same tuning as the Financial Dashboard's pool (v149).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  keepAlive: true,
  idleTimeoutMillis: 60_000,
});

export const db = drizzle(pool, { schema });
export { schema };
