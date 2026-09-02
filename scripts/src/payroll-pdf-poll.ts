/**
 * The Create-PDF queue poll — cheap on purpose.
 *
 * Every 15 minutes, ask the app how many Create-PDF requests are pending.
 * Zero — the overwhelmingly common case — costs one HTTPS round trip and
 * exits. Anything pending launches a Claude session running the payroll-pdf
 * skill, which does the judgment work this script cannot: find the row's
 * source email in payroll@, render it, file it in the synced SharePoint
 * folder, and report filed/failed back over the machine bridge.
 *
 * ⚠️ THIS RUNS ON BRAD'S MAC, and it has to — same constraint as the payroll
 * bridge beside it: the mailbox and the OneDrive-synced folder exist only
 * here. The app records the ask and shows the outcome; the work happens here.
 *
 * Install:
 *   (the keychain item is the same one the payroll bridge uses)
 *   cp deploy/com.kfi.payroll-pdf.plist ~/Library/LaunchAgents/
 *   launchctl load ~/Library/LaunchAgents/com.kfi.payroll-pdf.plist
 * Watch it:
 *   tail -f ~/Library/Logs/kfi-payroll-pdf.log
 */
import { execFile } from "node:child_process";
import os from "node:os";

const API = process.env["PAYROLL_API"] ?? "";
const KEY = process.env["PAYROLL_BRIDGE_KEY"] ?? "";

/** ⚠️ Every request is bounded — an unattended job with no timeout does not
 *  fail, it HANGS, and launchd will not start a second copy while one runs. */
const REQUEST_TIMEOUT_MS = Number(process.env["PAYROLL_PDF_TIMEOUT_MS"] ?? 60_000);
/** The executor session reads mail and renders PDFs; give it real time, but
 *  never forever — a hung session would silently stop the queue for good. */
const EXECUTOR_TIMEOUT_MS = Number(process.env["PAYROLL_PDF_EXECUTOR_TIMEOUT_MS"] ?? 20 * 60_000);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const fail: (msg: string) => never = (msg) => {
  console.error(new Date().toISOString(), "FAILED:", msg);
  process.exit(1);
};

async function pendingCount(): Promise<number> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/machine/payroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pulse-key": KEY },
      body: JSON.stringify({ kind: "pdf-claim", countOnly: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError"
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : e instanceof Error ? e.message : String(e);
    fail(`pdf-claim count: ${why}`);
  }
  if (!res.ok) fail(`pdf-claim count: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { pending?: number };
  return body.pending ?? 0;
}

function runExecutor(): Promise<void> {
  return new Promise((resolve) => {
    const child = execFile(
      "claude",
      [
        "-p", "/payroll-pdf",
        // Exactly what the skill needs and nothing more: shell + files for the
        // render/copy work, and the M365 connector for reading the mail.
        "--allowedTools", "Bash", "Read", "Write", "Edit",
        "mcp__claude_ai_Microsoft_365",
      ],
      {
        timeout: EXECUTOR_TIMEOUT_MS,
        killSignal: "SIGTERM",
        maxBuffer: 16 * 1024 * 1024,
        cwd: os.homedir(),
        env: process.env, // PAYROLL_API + PAYROLL_BRIDGE_KEY ride through
      },
      (err, stdout, stderr) => {
        const out = String(stdout).trim();
        const errOut = String(stderr).trim();
        if (out) log("executor:", out.slice(-4000));
        if (errOut) log("executor stderr:", errOut.slice(-2000));
        if (err) {
          // A non-zero exit is the skill refusing to guess (dead M365 token,
          // unreadable folder). The requests stay 'requested' and the next
          // cycle retries — say so rather than pretending the run was clean.
          console.error(new Date().toISOString(),
            `executor exited badly (${err.message}) — requests remain queued for the next cycle`);
          process.exitCode = 1;
        }
        resolve();
      },
    );
    child.on("error", () => { /* handled via the callback's err */ });
  });
}

async function main(): Promise<void> {
  if (!API) fail("PAYROLL_API is not set");
  if (!KEY) fail("PAYROLL_BRIDGE_KEY is not set — is the keychain item present?");

  const pending = await pendingCount();
  if (pending === 0) {
    log("0 pending — nothing to do");
    return;
  }
  log(`${pending} PDF request(s) pending — starting the executor session`);
  await runExecutor();
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
