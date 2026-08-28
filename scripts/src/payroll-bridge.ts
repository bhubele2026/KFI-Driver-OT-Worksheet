/**
 * The payroll bridge — the PD folder, pushed to the app.
 *
 * ⚠️ THIS RUNS ON BRAD'S MAC, and it has to. The PD folders live in OneDrive on
 * this machine, and the app has no Graph access to reach them. The app is the
 * surface; the extraction happens here. Same arrangement as the lease watcher,
 * and it goes away the same way if the tenant ever grants a daemon access.
 *
 * What it does: walk each recent pay period's folder, classify every file, and
 * push the inventory. It reads NOTHING out of the files themselves — a tile
 * needs to know the fringe import exists and when it was written, not what is
 * inside it. That also keeps the Expert Pay CSV, which carries unmasked SSNs,
 * out of the app entirely: it is recorded by name and never opened.
 *
 * Install:
 *   security add-generic-password -U -a "$USER" -s kfi-payroll-bridge-key -w '<PULSE_SHARED_SECRET>'
 *   cp deploy/com.kfi.payroll-bridge.plist ~/Library/LaunchAgents/
 *   launchctl load ~/Library/LaunchAgents/com.kfi.payroll-bridge.plist
 * Watch it:
 *   tail -f ~/Library/Logs/kfi-payroll-bridge.log
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(
  os.homedir(),
  "Library/CloudStorage/OneDrive-KrugerFamilyIndustries/KFI Payroll - Associate-External Payroll",
);
const API = process.env["PAYROLL_API"] ?? "";
const KEY = process.env["PAYROLL_BRIDGE_KEY"] ?? "";
/** How many recent periods to inventory. Older folders never change. */
const PERIODS = Number(process.env["PAYROLL_BRIDGE_PERIODS"] ?? 4);
/** express.json caps at 2mb, so chunk well under it. */
const CHUNK = 400;
const DRY = process.argv.includes("--dry-run");

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
/**
 * ⚠️ The annotation is on the VARIABLE, not just the arrow. TypeScript only
 * treats a call as never-returning for control-flow analysis when the const
 * itself is typed — without that, every `fail()` in a catch block leaves the
 * compiler thinking execution continues.
 */
const fail: (msg: string) => never = (msg) => {
  console.error(new Date().toISOString(), "FAILED:", msg);
  process.exit(1);
};

// ── the classifier, kept in step with the server's copy ─────────────────────
// Deliberately duplicated rather than imported: this script must run from a
// plain `tsx` with no workspace build, and a stale dist/ is worse than a copy
// that a test pins. `scripts/src/__tests__` asserts the two agree.
const fold = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

const BY_FOLDER: Record<string, string> = {
  "client ts": "client_timesheet",
  "daily total and daily clock in and clock out": "daily_punches",
  "driver timesheets": "driver_timesheet",
  "transaction batches": "transaction_batch_report",
  "payment batches": "payment_batch_report",
  "expert pay": "expert_pay",
  "bank feed": "bank_feed",
  documentation: "documentation",
};

const NUMBERED_SOP = /^\d[\d ]*[a-z]/;

const RULES: Array<[RegExp, string]> = [
  [/cs expert pay|expert pay/, "expert_pay"],
  [/holiday pay eligibility|holiday pay payment detail|holiday pay active assign/, "holiday_eligibility"],
  [/holiday pay for import/, "holiday_import"],
  [/rapid|deactivated cards/, "paycard"],
  [/original download/, "master_export_raw"],
  [/master external.*(without|witout) driver/, "master_import_no_driver"],
  [/monday batch.*(without) driver/, "master_import_no_driver"],
  [/master external.*(fringe|mn esst|referral|cell|ach|expense|refund)/, "fringe_import"],
  [/master external.*for import|monday batch.*for import/, "master_import"],
  [/master external/, "master_export"],
  [/housing and transportation deductions|housing deductions for import|transportation deductions for import/, "deduction_import"],
  [/fringe for import|fringe import/, "fringe_import"],
  [/driver pay units|driver_pay_units/, "driver_pay_units"],
  [/driver timecards|driver only|driver timesheet/, "driver_timesheet"],
  [/kfiweeklytimesheetexport/, "customer_template"],
  [/daily punches|daily clock in|clock in and clock out/, "daily_punches"],
  [/transactionbatchreport|transaction batch report/, "transaction_batch_report"],
  [/paymentbatchreport|payment batch report/, "payment_batch_report"],
  [/bank feed/, "bank_feed"],
  [/payroll changes for pd|payroll changes pd/, "changes_workbook"],
  [/advance/, "advance"],
  [/void|correction|reissue/, "void_or_correction"],
  [/approval|email from|permission to approve/, "approval_email"],
  [/work instruction|how to |instructions/, "work_instruction"],
];

export function classify(fileName: string, subfolder: string): { kind: string; sensitive: boolean } {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (ext === "mp4") return { kind: "screen_recording", sensitive: false };
  const name = fold(fileName);
  const folder = fold(subfolder);
  if (folder === "expert pay" || /expert pay/.test(name)) {
    return { kind: "expert_pay", sensitive: true };
  }
  const byFolder = BY_FOLDER[folder];
  if (byFolder) return { kind: byFolder, sensitive: false };
  if ((ext === "docx" || ext === "doc") &&
      (NUMBERED_SOP.test(name) || /^example of|^how to |work instruction|instructions/.test(name))) {
    return { kind: "work_instruction", sensitive: false };
  }
  if (/^example of/.test(name)) return { kind: "work_instruction", sensitive: false };
  for (const [re, kind] of RULES) if (re.test(name)) return { kind, sensitive: kind === "expert_pay" };
  if (/for import/.test(name)) return { kind: "master_import", sensitive: false };
  if (/pay stub|paystub/.test(name)) return { kind: "documentation", sensitive: false };
  if (/cost calculator|housing occupancy/.test(name)) return { kind: "reference_analysis", sensitive: false };
  return { kind: "unknown", sensitive: false };
}

// ── period discovery ────────────────────────────────────────────────────────
export function parsePeriodFolder(name: string): { payDate: string; isOffCycle: boolean } | null {
  const m = /^PD\s+(\d{2})\.(\d{2})\.(\d{4})(\s+Off\s*Cycle)?\s*$/i.exec(name.trim());
  if (!m) return null;
  return { payDate: `${m[3]}-${m[1]}-${m[2]}`, isOffCycle: Boolean(m[4]) };
}

type Artifact = {
  relPath: string; subfolder: string; fileName: string; ext: string;
  sizeBytes: number; modifiedAt: string; artifactKind: string; sensitive: boolean;
};

function inventory(periodDir: string): Artifact[] {
  const out: Artifact[] = [];
  const walk = (dir: string, sub: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a folder that vanished mid-walk is not a failure
    }
    for (const e of entries) {
      if (e.name === ".DS_Store") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, e.name); continue; }
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      const c = classify(e.name, sub);
      out.push({
        relPath: path.relative(periodDir, full),
        subfolder: sub,
        fileName: e.name,
        ext: (e.name.split(".").pop() ?? "").toLowerCase(),
        sizeBytes: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        artifactKind: c.kind,
        sensitive: c.sensitive,
      });
    }
  };
  walk(periodDir, "");
  return out;
}

/**
 * ⚠️ EVERY REQUEST IS BOUNDED. An unattended job with no timeout does not fail,
 * it HANGS — and launchd will not start a second copy while one is still
 * running, so a single stuck request silently stops the bridge for good. The
 * symptom is not an error, it is stale data nobody notices.
 */
const REQUEST_TIMEOUT_MS = Number(process.env["PAYROLL_BRIDGE_TIMEOUT_MS"] ?? 60_000);

async function push(payDate: string, isOffCycle: boolean, artifacts: Artifact[]): Promise<void> {
  const chunks = Math.ceil(artifacts.length / CHUNK);
  for (let i = 0; i < artifacts.length; i += CHUNK) {
    const slice = artifacts.slice(i, i + CHUNK);
    const n = i / CHUNK + 1;
    const more = i + CHUNK < artifacts.length;

    let res: Response;
    try {
      res = await fetch(`${API}/api/machine/payroll`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pulse-key": KEY },
        body: JSON.stringify({ payDate, isOffCycle, kind: "artifacts", more, artifacts: slice }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const why = e instanceof Error && e.name === "TimeoutError"
        ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
        : e instanceof Error ? e.message : String(e);
      // Say how far it got: artifacts upsert by path, so a partial push is
      // recoverable on the next run rather than lost — but only if the log
      // makes clear it WAS partial.
      fail(`push ${payDate} chunk ${n}/${chunks}: ${why}` +
           (n > 1 ? ` — ${i} artifacts were already accepted and will not be re-sent until the next run` : ""));
    }

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      fail(`push ${payDate} chunk ${n}/${chunks}: ${res.status} ${body}` +
           (n > 1 ? ` — ${i} artifacts already accepted` : ""));
    }
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(ROOT)) fail(`payroll root not found: ${ROOT}`);
  if (!DRY && !API) fail("PAYROLL_API is not set");
  if (!DRY && !KEY) fail("PAYROLL_BRIDGE_KEY is not set — is the keychain item present?");

  const periods = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, parsed: parsePeriodFolder(e.name) }))
    .filter((p): p is { name: string; parsed: { payDate: string; isOffCycle: boolean } } =>
      p.parsed !== null)
    // Newest first, and skip the far-future template stamp.
    .filter((p) => p.parsed.payDate < "2026-12-01")
    .sort((a, b) => (a.parsed.payDate < b.parsed.payDate ? 1 : -1))
    .slice(0, PERIODS);

  if (periods.length === 0) {
    // ⚠️ Zero periods means the folder moved or OneDrive is not synced — it does
    // NOT mean there is no payroll. Fail loudly rather than pushing nothing.
    fail("no PD folders found — is OneDrive synced?");
  }

  let pushed = 0;
  let sensitive = 0;
  for (const p of periods) {
    const dir = path.join(ROOT, p.name);
    const artifacts = inventory(dir);
    if (artifacts.length === 0) {
      log(`SKIP ${p.name} — folder is empty, keeping whatever the app already has`);
      continue;
    }
    sensitive += artifacts.filter((a) => a.sensitive).length;
    const kinds = new Map<string, number>();
    for (const a of artifacts) kinds.set(a.artifactKind, (kinds.get(a.artifactKind) ?? 0) + 1);
    const unknown = kinds.get("unknown") ?? 0;
    log(`${p.name}: ${artifacts.length} files, ${kinds.size} kinds${unknown ? `, ${unknown} unknown` : ""}`);
    if (DRY) {
      [...kinds].sort((a, b) => b[1] - a[1])
        .forEach(([k, n]) => log(`    ${String(n).padStart(4)}  ${k}`));
      continue;
    }
    await push(p.parsed.payDate, p.parsed.isOffCycle, artifacts);
    pushed += artifacts.length;
  }

  log(`done — ${pushed} artifacts pushed across ${periods.length} periods`);
  log(`${sensitive} sensitive files recorded by NAME ONLY (never opened)`);
}

// Only run when invoked directly. Importing this module (the parity test does)
// must not walk OneDrive and push to production.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
}
