import type { Punch } from "@workspace/db/schema";
import { IWG_DRIVER_IDS } from "./mappings.js";
import { CT_TZ, localStrToSortMs, isoDateToUtcMs, listDates } from "./time.js";

export const OT_THRESHOLD = 40;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

interface MergedPunch {
  punch: Punch;
  hours: number;
  source: "Driver" | "Customer";
}

/**
 * Split per-driver punches chronologically into RT (up to 40h/week) and OT
 * (anything over 40). Splits a punch that crosses the 40-hour boundary.
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
  let totalDriver = 0;
  let totalCustomer = 0;
  for (const p of punches) {
    const h = Number(p.hours);
    if (p.source === "Driver") totalDriver += h;
    else totalCustomer += h;
  }

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
  let driverRt = 0;
  let driverOt = 0;
  let custRt = 0;
  let custOt = 0;

  for (const m of sorted) {
    const h = m.hours;
    const rtPortion = Math.max(0, Math.min(h, OT_THRESHOLD - running));
    const otPortion = h - rtPortion;
    running += h;
    if (m.source === "Driver") {
      driverRt += rtPortion;
      driverOt += otPortion;
    } else {
      custRt += rtPortion;
      custOt += otPortion;
    }
  }

  const total = totalDriver + totalCustomer;
  const rt = driverRt + custRt;
  const ot = driverOt + custOt;
  return {
    totalDriver: r3(totalDriver),
    totalCustomer: r3(totalCustomer),
    driverRt: r2(driverRt),
    driverOt: r2(driverOt),
    custRt: r2(custRt),
    custOt: r2(custOt),
    totalHours: r3(total),
    regularHours: r2(rt),
    overtimeHours: r2(ot),
    hasOvertime: ot > 0.005,
  };
}

export interface DailyTotal {
  date: string;
  driverHours: number;
  customerHours: number;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
}

/** Per-day breakdown for the driver detail page. */
export function computeDailyTotals(
  punches: Punch[],
  weekStart: string,
  weekEnd: string,
): DailyTotal[] {
  const byDate = new Map<string, { d: number; c: number; rt: number; ot: number }>();
  for (const dt of listDates(weekStart, weekEnd)) {
    byDate.set(dt, { d: 0, c: 0, rt: 0, ot: 0 });
  }

  // Daily driver/customer totals are simple sums.
  for (const p of punches) {
    const slot = byDate.get(p.date);
    if (!slot) continue;
    const h = Number(p.hours);
    if (p.source === "Driver") slot.d += h;
    else slot.c += h;
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

  return [...byDate.entries()].map(([date, v]) => ({
    date,
    driverHours: r3(v.d),
    customerHours: r3(v.c),
    totalHours: r3(v.d + v.c),
    regularHours: r2(v.rt),
    overtimeHours: r2(v.ot),
  }));
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
      out.push({
        level: "error",
        message: "Clock-out before clock-in",
        date: r.date,
      });
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
