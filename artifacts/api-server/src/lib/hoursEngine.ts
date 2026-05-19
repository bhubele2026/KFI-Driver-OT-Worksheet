import type { Punch } from "@workspace/db/schema";
import { IWG_DRIVER_IDS } from "./mappings.js";
import { CT_TZ, localStrToSortMs, isoDateToUtcMs, listDates } from "./time.js";

export const OT_THRESHOLD = 40;

const r2 = (n: number): number => Math.round(n * 100) / 100;

interface MergedPunch {
  punch: Punch;
  hours: number;
  source: "Driver" | "Customer";
}

/**
 * Split per-driver punches chronologically into RT (up to 40h/week) and OT
 * (anything over 40). Splits a punch that crosses the 40-hour boundary.
 *
 * Rounding: every public number is 2 decimals (matches what Connecteam shows
 * to the driver). Independent rounding of the four chronological buckets
 * (driverRt, driverOt, custRt, custOt) used to drift by ±0.01 from the
 * 2-decimal `regularHours`/`overtimeHours` totals — all of which then
 * landed in OT, so a clean reconciliation looked like a payroll error.
 * To keep everything reconciled exactly we:
 *   1. Sum each source first (`totalDriver`, `totalCustomer`) and round to 2dp.
 *   2. `totalHours = round(totalDriver + totalCustomer, 2)` — single rounding.
 *   3. `regularHours = min(totalHours, 40)`, `overtimeHours = totalHours - regularHours`.
 *      Guarantees `regularHours + overtimeHours === totalHours`.
 *   4. For per-source RT/OT, round one bucket from the raw chronological
 *      split, then back the other out by subtraction (driverOt = totalDriver
 *      - driverRt; custRt = regularHours - driverRt; custOt = overtimeHours
 *      - driverOt). Any rounding delta is distributed across both buckets
 *      proportionally rather than dumped into OT.
 */
export function computeDriverTotals(punches: Punch[]): {
  totalDriver: number;
  totalCustomer: number;
  driverRt: number;
  driverOt: number;
  custRt: number;
  custOt: number;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
  hasOvertime: boolean;
} {
  let rawDriver = 0;
  let rawCustomer = 0;
  for (const p of punches) {
    const h = Number(p.hours);
    if (p.source === "Driver") rawDriver += h;
    else rawCustomer += h;
  }
  const totalDriver = r2(rawDriver);
  const totalCustomer = r2(rawCustomer);
  const totalHours = r2(totalDriver + totalCustomer);
  const regularHours = Math.min(totalHours, OT_THRESHOLD);
  const overtimeHours = r2(totalHours - regularHours);

  const sorted: MergedPunch[] = [...punches]
    .map((punch) => ({
      punch,
      hours: Number(punch.hours),
      source: punch.source as "Driver" | "Customer",
    }))
    .sort((a, b) => {
      const ta = localStrToSortMs(a.punch.clockIn) ?? isoDateToUtcMs(a.punch.date);
      const tb = localStrToSortMs(b.punch.clockIn) ?? isoDateToUtcMs(b.punch.date);
      return ta - tb;
    });

  let running = 0;
  let rawDriverRt = 0;
  for (const m of sorted) {
    const h = m.hours;
    const rtPortion = Math.max(0, Math.min(h, OT_THRESHOLD - running));
    running += h;
    if (m.source === "Driver") rawDriverRt += rtPortion;
  }

  // Anchor on driverRt (the chronological bucket the engine actually
  // computes), then derive the other three by subtraction so the four
  // numbers always reconcile to totalDriver / totalCustomer / regularHours
  // / overtimeHours without rounding artifacts.
  let driverRt = r2(rawDriverRt);
  if (driverRt > totalDriver) driverRt = totalDriver;
  if (driverRt > regularHours) driverRt = regularHours;
  const driverOt = r2(totalDriver - driverRt);
  const custRt = r2(regularHours - driverRt);
  const custOt = r2(overtimeHours - driverOt);

  return {
    totalDriver,
    totalCustomer,
    driverRt,
    driverOt,
    custRt,
    custOt,
    totalHours,
    regularHours: r2(regularHours),
    overtimeHours,
    hasOvertime: overtimeHours > 0.005,
  };
}

export interface DailyTotal {
  date: string;
  driverHours: number;
  customerHours: number;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
  /**
   * True when every contributing punch on this day is flagged `edited=true`
   * — i.e. the day total was dispatcher-overridden via `/scale-hours`
   * (which stamps `edited` on every row it scales). Days with no punches
   * are not overridden.
   */
  hasOverrides: boolean;
}

/** Per-day breakdown for the driver detail page. */
export function computeDailyTotals(
  punches: Punch[],
  weekStart: string,
  weekEnd: string,
): DailyTotal[] {
  const byDate = new Map<
    string,
    { d: number; c: number; rt: number; ot: number; count: number; editedCount: number }
  >();
  for (const dt of listDates(weekStart, weekEnd)) {
    byDate.set(dt, { d: 0, c: 0, rt: 0, ot: 0, count: 0, editedCount: 0 });
  }

  // Daily driver/customer totals are simple sums.
  for (const p of punches) {
    const slot = byDate.get(p.date);
    if (!slot) continue;
    const h = Number(p.hours);
    if (p.source === "Driver") slot.d += h;
    else slot.c += h;
    slot.count += 1;
    if (p.edited) slot.editedCount += 1;
  }

  // Daily RT/OT requires the same chronological 40h split, but credited
  // to the *day the shift started on*.
  const sorted = [...punches].sort((a, b) => {
    const ta = localStrToSortMs(a.clockIn) ?? isoDateToUtcMs(a.date);
    const tb = localStrToSortMs(b.clockIn) ?? isoDateToUtcMs(b.date);
    return ta - tb;
  });
  let running = 0;
  for (const p of sorted) {
    const h = Number(p.hours);
    const rt = Math.max(0, Math.min(h, OT_THRESHOLD - running));
    const ot = h - rt;
    running += h;
    const slot = byDate.get(p.date);
    if (slot) {
      slot.rt += rt;
      slot.ot += ot;
    }
  }

  return [...byDate.entries()].map(([date, v]) => {
    // Same anchor-and-subtract trick as the weekly totals: round the day
    // total once, then back overtimeHours out so rt+ot===total per day.
    const driverHours = r2(v.d);
    const customerHours = r2(v.c);
    const totalHours = r2(driverHours + customerHours);
    const overtimeHours = r2(Math.max(0, v.ot));
    let regularHours = r2(totalHours - overtimeHours);
    if (regularHours < 0) regularHours = 0;
    return {
      date,
      driverHours,
      customerHours,
      totalHours,
      regularHours,
      overtimeHours,
      hasOverrides: v.count > 0 && v.editedCount === v.count,
    };
  });
}

export interface PunchCheck {
  level: "info" | "warn" | "error";
  message: string;
  date: string | null;
}

/** Validation flags shown on the driver detail page. */
export function computeChecks(punches: Punch[]): PunchCheck[] {
  const out: PunchCheck[] = [];
  const sorted = [...punches].sort((a, b) => {
    const ta = localStrToSortMs(a.clockIn) ?? isoDateToUtcMs(a.date);
    const tb = localStrToSortMs(b.clockIn) ?? isoDateToUtcMs(b.date);
    return ta - tb;
  });

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const ci = localStrToSortMs(r.clockIn);
    const co = localStrToSortMs(r.clockOut);
    if (!r.clockIn || r.clockIn === r.date) {
      out.push({ level: "error", message: "Missing clock-in", date: r.date });
      continue;
    }
    if (!r.clockOut || r.clockOut === r.date) {
      out.push({ level: "error", message: "Missing clock-out", date: r.date });
      continue;
    }
    if (ci !== null && co !== null && co <= ci) {
      continue;
    }
    if (ci !== null && co !== null) {
      // Same-source overlap >10 min = data error.
      for (let j = 0; j < i; j++) {
        const prev = sorted[j];
        if (prev.source !== r.source) continue;
        const pci = localStrToSortMs(prev.clockIn);
        const pco = localStrToSortMs(prev.clockOut);
        if (pci === null || pco === null) continue;
        const overlapMs = Math.min(co, pco) - Math.max(ci, pci);
        if (overlapMs > 10 * 60 * 1000) {
          const overlapMins = Math.round(overlapMs / 60000);
          out.push({
            level: "warn",
            message: `${r.source} punches overlap by ${overlapMins} min`,
            date: r.date,
          });
          break;
        }
      }
    }
  }
  return out;
}

export function defaultDispTz(kfiId: string): string {
  return IWG_DRIVER_IDS.has(kfiId) ? "America/New_York" : CT_TZ;
}
