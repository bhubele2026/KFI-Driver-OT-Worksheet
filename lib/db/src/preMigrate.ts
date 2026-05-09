import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set before running the pre-migrate fixups.",
  );
}

type Fixup = {
  name: string;
  describe: string;
  detect: string;
  apply: string;
};

const FIXUPS: Fixup[] = [
  {
    name: "customer_upload_attempts.last_unmapped_ids text[] -> jsonb",
    describe:
      "drizzle-kit push cannot auto-cast text[] to jsonb; convert in place.",
    detect: `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'customer_upload_attempts'
        AND column_name = 'last_unmapped_ids'
        AND data_type = 'ARRAY'
    `,
    apply: `
      ALTER TABLE customer_upload_attempts
      ALTER COLUMN last_unmapped_ids TYPE jsonb
      USING CASE
        WHEN last_unmapped_ids IS NULL THEN NULL
        ELSE to_jsonb(last_unmapped_ids)
      END
    `,
  },
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const fixup of FIXUPS) {
      const detected = await client.query(fixup.detect);
      if (detected.rowCount && detected.rowCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[pre-migrate] applying: ${fixup.name}`);
        await client.query(fixup.apply);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[pre-migrate] failed:", err);
  process.exit(1);
});
