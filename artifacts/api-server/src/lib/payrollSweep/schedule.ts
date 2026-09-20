import { logger } from "../logger.js";
import { queueSweep } from "./macQueue.js";

/**
 * The nightly tick.
 *
 * Modelled on `startHiddenNotesDigest`: check the hour, guard once-per-day,
 * never let a failure escalate, and `unref()` so it cannot hold the process
 * open. The difference is that the digest's in-memory day marker assumed a
 * single process — this app runs TWO replicas, so the real once-per-night
 * guarantee lives in `runPayrollSweep`'s advisory-lock claim. The marker here
 * only saves a wasted database round trip.
 */

const TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 5am Central, which is 11:00 UTC during CDT.
 *
 * ⚠️ A fixed UTC hour drifts by an hour across a DST change — this fires at
 * 4am Central in winter. That is accepted rather than fixed: the requirement
 * is "before Tiana starts", which has hours of slack, and a real timezone
 * library here would be more machinery than the problem deserves. Override
 * with PAYROLL_SWEEP_HOUR_UTC if that ever stops being true.
 */
function sweepHourUtc(): number {
  const raw = process.env.PAYROLL_SWEEP_HOUR_UTC;
  if (!raw) return 11;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) return 11;
  return n;
}

let lastRunYmdUtc: string | null = null;

export function _resetSweepSchedulerStateForTests(): void {
  lastRunYmdUtc = null;
}

export function startPayrollSweepNightly(): NodeJS.Timeout | null {
  // Off unless switched on, the same gate `scheduleUploadAnalysis` uses. A
  // deploy must never start reading a mailbox because a module got imported.
  if (process.env.PAYROLL_SWEEP_ENABLED !== "1") {
    logger.info("payroll sweep: nightly run disabled (PAYROLL_SWEEP_ENABLED != 1)");
    return null;
  }
  // ⚠️ Say what actually happens. An earlier version logged "will not start"
  // and then logged "scheduled" on the very next line — two lines that
  // contradict each other are worse than one that is vague, especially for
  // something a person only ever reads at 5am when it misbehaved. The tick IS
  // scheduled; it stands down each night until the credentials exist.
  const hour = sweepHourUtc();
  const tick = () => {
    const now = new Date();
    if (now.getUTCHours() !== hour) return;
    const ymd = now.toISOString().slice(0, 10);
    if (lastRunYmdUtc === ymd) return;
    lastRunYmdUtc = ymd;
    // ⭐ Queue it; do not run it. Azure never sleeps, the Mac does — so the
    // 5am tick writes the intent here and the Mac drains it when it wakes. A
    // laptop asleep for three nights yields ONE sweep covering the gap,
    // because queueSweep refuses to stack a second while one is waiting.
    queueSweep("nightly", null)
      .then((q) => logger.info({ ...q }, "payroll sweep: nightly run queued"))
      .catch((err) => logger.warn({ err }, "payroll sweep: nightly tick failed"));
  };
  void tick();
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  logger.info({ hourUtc: hour }, "payroll sweep: nightly run scheduled");
  return handle;
}
