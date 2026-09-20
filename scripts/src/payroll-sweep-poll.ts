/**
 * The mailbox-sweep executor trigger — the twin of payroll-pdf-poll.ts.
 *
 * Holds a long-poll against the app. The moment Tiana presses "Run sweep" on
 * the Changes & Deductions board — or the app's own 5am tick queues one — the
 * poll releases and a Claude session runs the `payroll-sweep` skill, which
 * reads payroll@ and pushes what it finds back over the machine bridge.
 *
 * ⚠️ THIS RUNS ON BRAD'S MAC, and it has to. Reading the mailbox from the
 * server would need an administrator to approve app-only Graph access, and
 * Brad holds no directory role. The delegated access he already has as a
 * person lives here, so the fetching lives here too.
 *
 * ⭐ A SLEEPING MAC DEFERS WORK, IT DOES NOT LOSE IT. The queue is a table in
 * Azure. While this machine is asleep nothing polls, the request simply waits,
 * and on waking the long-poll returns immediately with it. Several missed
 * nights collapse into ONE sweep: the server computes the window at claim
 * time from the last successful run, not from when the run was queued.
 *
 * Install:
 *   cp deploy/com.kfi.payroll-sweep.plist ~/Library/LaunchAgents/
 *   launchctl load ~/Library/LaunchAgents/com.kfi.payroll-sweep.plist
 * Watch it:
 *   tail -f ~/Library/Logs/kfi-payroll-sweep.log
 */
import { execFile } from "node:child_process";
import os from "node:os";

const API = process.env["PAYROLL_API"] ?? "";
const KEY = process.env["PAYROLL_BRIDGE_KEY"] ?? "";

/** ⚠️ Bounded, always. An unattended job with no timeout does not fail, it
 *  hangs — and launchd will not start a second copy while one runs. */
const REQUEST_TIMEOUT_MS = Number(process.env["PAYROLL_SWEEP_TIMEOUT_MS"] ?? 60_000);
/** The session reads a fortnight of mail and pushes it in chunks. Give it real
 *  time; never forever. */
const EXECUTOR_TIMEOUT_MS = Number(process.env["PAYROLL_SWEEP_EXECUTOR_TIMEOUT_MS"] ?? 45 * 60_000);
/** How long the server holds the long-poll before answering "nothing yet". */
const WAIT_HOLD_SECONDS = 230;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const fail: (msg: string) => never = (msg) => {
  console.error(new Date().toISOString(), "FAILED:", msg);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/api/machine/payroll`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pulse-key": KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Record<string, unknown>;
}

async function pendingCount(): Promise<number> {
  const body = await post({ kind: "sweep-claim", countOnly: true });
  return Number(body.pending ?? 0);
}

/** Resolves true when the executor session exited cleanly. */
function runExecutor(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      "claude",
      [
        "-p", "/payroll-sweep",
        // Exactly what the skill needs: shell + files to stage the pushes, and
        // the M365 connector to read the mailbox. Nothing else.
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
          // A non-zero exit is the skill refusing to guess — a dead M365
          // token, an unreachable app. The run stays claimable and a later
          // attempt retries. Say so rather than pretending it was clean.
          console.error(new Date().toISOString(),
            `executor exited badly (${err.message}) — the sweep stays queued`);
          process.exitCode = 1;
        }
        resolve(!err);
      },
    );
    child.on("error", () => { /* handled via the callback's err */ });
  });
}

async function waitLoop(): Promise<void> {
  log("wait mode — a Run sweep press releases the long-poll within seconds");
  for (;;) {
    let pending = 0;
    try {
      const body = await post(
        { kind: "sweep-wait", timeoutSeconds: WAIT_HOLD_SECONDS },
        (WAIT_HOLD_SECONDS + 30) * 1000,
      );
      pending = Number(body.pending ?? 0);
    } catch (e) {
      // This is also the normal path on WAKE FROM SLEEP: the held socket died
      // while the lid was shut. Back off briefly and re-arm; the queued sweep
      // is still sitting in the database waiting for us.
      const why = e instanceof Error && e.name === "TimeoutError"
        ? "timed out" : e instanceof Error ? e.message : String(e);
      log(`wait: ${why} — retrying in 30s`);
      await sleep(30_000);
      continue;
    }
    if (pending > 0) {
      log(`${pending} sweep(s) queued — starting the executor session`);
      const ok = await runExecutor();
      // ⚠️ A failed run leaves the sweep queued, and sweep-wait then returns
      // IMMEDIATELY — without this check an executor that dies at startup
      // hot-spins the loop. Any run that errored or left the queue no smaller
      // earns a long cool-off. (The PDF daemon learned this the hard way:
      // megabytes of log in seconds.)
      let after = pending;
      try { after = await pendingCount(); } catch { /* keep the pessimistic value */ }
      if (!ok || after >= pending) {
        const why = ok ? `queue did not shrink (${pending} → ${after})` : "the executor failed";
        log(`backing off 5 minutes — ${why}; the sweep stays queued`);
        await sleep(5 * 60_000);
      }
    }
  }
}

async function main(): Promise<void> {
  if (!API) fail("PAYROLL_API is not set");
  if (!KEY) fail("PAYROLL_BRIDGE_KEY is not set — is the keychain item present?");

  if (process.argv.includes("--wait")) {
    await waitLoop();
    return;
  }
  const pending = await pendingCount();
  if (pending === 0) {
    log("0 queued — nothing to do");
    return;
  }
  log(`${pending} sweep(s) queued — starting the executor session`);
  await runExecutor();
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
