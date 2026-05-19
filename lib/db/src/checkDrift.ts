import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set before running the schema-drift check.",
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, "../drizzle.config.ts");

const child = spawn(
  "pnpm",
  [
    "exec",
    "drizzle-kit",
    "push",
    "--verbose",
    "--strict",
    "--config",
    configPath,
  ],
  { stdio: ["pipe", "pipe", "pipe"], env: process.env },
);

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

// Always refuse the confirmation prompt so we never actually mutate the DB.
// drizzle-kit's --strict mode reads a single answer from stdin; "No" is safe.
child.stdin.write("No\n");
child.stdin.end();

child.on("close", (code) => {
  // Strip ANSI color codes and the spinner frames so the output is greppable.
  const clean = stdout
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\[[⣷⣯⣟⡿⢿⣻⣽⣾]\][^\n]*\n/g, "");

  if (clean.includes("No changes detected")) {
    // eslint-disable-next-line no-console
    console.log("[check-drift] dev DB matches Drizzle schema.");
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.error(
    "[check-drift] Dev DB is out of sync with the Drizzle schema.",
  );
  // eslint-disable-next-line no-console
  console.error(
    "[check-drift] Run `pnpm --filter @workspace/db run push` to sync, then re-run.",
  );
  // eslint-disable-next-line no-console
  console.error("[check-drift] drizzle-kit output:");
  // eslint-disable-next-line no-console
  console.error(clean.trim());
  if (stderr.trim()) {
    // eslint-disable-next-line no-console
    console.error("[check-drift] drizzle-kit stderr:");
    // eslint-disable-next-line no-console
    console.error(stderr.trim());
  }
  process.exit(code && code !== 0 ? code : 1);
});
