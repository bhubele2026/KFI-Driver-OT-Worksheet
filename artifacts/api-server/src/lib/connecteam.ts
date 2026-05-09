import {
  IWG_DRIVER_IDS,
  SHUSTER_CLOCK_IDS,
  TIME_CLOCKS,
  USER_ID_ALIASES_LD,
} from "./mappings.js";
import { CT_TZ, msToLocalStr, msToLocalDate, addDays } from "./time.js";

const CT_BASE = "https://api.connecteam.com";

interface CtUser {
  userId: number;
  firstName?: string;
  lastName?: string;
  archived?: boolean;
  customFields?: Array<{ name?: string; value?: unknown }>;
  isOwner?: boolean;
}

interface CtShift {
  start?: { timestamp?: number };
  end?: { timestamp?: number };
  userId?: number;
}

export interface ConnecteamPunch {
  kfiId: string;
  ctUserId: number;
  date: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  dispTz: string;
  ctExternalKey: string;
}

export interface ConnecteamDriver {
  ctUserId: number;
  kfiId: string;
  name: string;
  customer: string;
  isDriver: boolean;
  isArchived: boolean;
}

function token(): string {
  const t = process.env.CONNECTEAM_API_TOKEN;
  if (!t) throw new Error("CONNECTEAM_API_TOKEN is required");
  return t;
}

async function ctFetch(path: string): Promise<unknown> {
  const res = await fetch(`${CT_BASE}${path}`, {
    headers: {
      "X-API-KEY": token(),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Connecteam ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function getCustomFieldValue(u: CtUser, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const f of u.customFields ?? []) {
    if (typeof f.name === "string" && f.name.toLowerCase().includes(lower)) {
      return coerceCustomFieldValue(f.value);
    }
  }
  return undefined;
}

/**
 * Some Connecteam roster entries have date-shaped junk in the Customer
 * dropdown ("12/22/2025", "01-23-2026", "2026-01-23"). These leak into the
 * dashboard as their own customer groups, which is meaningless and confusing.
 * Treat anything that parses as a date as no-customer so the driver lands in
 * the "Needs roster cleanup" bucket until someone fixes the roster entry.
 */
export function looksLikeRosterDateJunk(value: string | undefined): boolean {
  if (!value) return false;
  const s = value.trim();
  if (!s) return false;
  // M/D/YY, M/D/YYYY, MM/DD/YYYY, with / or - separators, optional leading 0s.
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2}(\d{2})?$/.test(s)) return true;
  // ISO YYYY-MM-DD or YYYY/MM/DD.
  if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(s)) return true;
  return false;
}

/**
 * Connecteam custom-field values are typed (`str`, `dropdown`, `directManager`,
 * etc). Dropdown values come back as `[{ id, value }]` (array), and other
 * structured types may come back as `{ value: "..." }`. Naive `String(value)`
 * yields `"[object Object]"` and corrupts the customer column. This helper
 * unwraps the common shapes and returns a plain string, or undefined if there
 * is nothing usable.
 */
export function coerceCustomFieldValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => coerceCustomFieldValue(v))
      .filter((v): v is string => Boolean(v));
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (typeof value === "object") {
    const inner = (value as { value?: unknown; name?: unknown }).value
      ?? (value as { value?: unknown; name?: unknown }).name;
    return coerceCustomFieldValue(inner);
  }
  return undefined;
}

export interface ConnecteamTimeClock {
  id: number;
  name: string;
  isArchived: boolean;
}

/** List every time-clock that exists in the Connecteam account (paginated). */
export async function fetchAllTimeClocks(): Promise<ConnecteamTimeClock[]> {
  const out: ConnecteamTimeClock[] = [];
  const seen = new Set<number>();
  const limit = 200;
  let offset = 0;
  // Hard cap iterations so a malformed response can't infinite-loop.
  for (let page = 0; page < 50; page++) {
    const data = (await ctFetch(
      `/time-clock/v1/time-clocks?limit=${limit}&offset=${offset}`,
    )) as {
      data?: {
        timeClocks?: Array<{ id: number; name?: string; isArchived?: boolean }>;
      };
    };
    const list = data?.data?.timeClocks ?? [];
    if (list.length === 0) break;
    let added = 0;
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({
        id: c.id,
        name: c.name ?? `Clock ${c.id}`,
        isArchived: Boolean(c.isArchived),
      });
      added++;
    }
    // Defense in depth: if the page returned only dupes, stop to avoid loops.
    if (added === 0) break;
    if (list.length < limit) break;
    offset += limit;
  }
  return out;
}

/** Fetch the entire user roster (paginated, 500/page). */
export async function fetchAllUsers(): Promise<ConnecteamDriver[]> {
  const drivers: ConnecteamDriver[] = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const data = (await ctFetch(
      `/users/v1/users?limit=${limit}&offset=${offset}`,
    )) as { data?: { users?: CtUser[] } };
    const users = data?.data?.users ?? [];
    if (users.length === 0) break;
    for (const u of users) {
      if (u.isOwner) continue;
      const kfiRaw = getCustomFieldValue(u, "kfi") ?? getCustomFieldValue(u, "employee id");
      const kfiId = (kfiRaw ?? String(u.userId)).trim();
      if (!kfiId) continue;
      const customerRaw = getCustomFieldValue(u, "customer");
      const customer = looksLikeRosterDateJunk(customerRaw)
        ? "Unknown"
        : customerRaw ?? "Unknown";
      const isDriverField = getCustomFieldValue(u, "driver");
      const isDriver = isDriverField
        ? /yes|true|1|y/i.test(isDriverField)
        : true;
      drivers.push({
        ctUserId: u.userId,
        kfiId,
        name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || `User ${u.userId}`,
        customer,
        isDriver,
        isArchived: Boolean(u.archived),
      });
    }
    if (users.length < limit) break;
    offset += limit;
  }
  return drivers;
}

/**
 * Pull all driver punches in [startIso, endIsoInclusive] from every configured
 * time-clock and normalize to wall-clock display strings.
 */
export async function fetchPunchesForWeek(
  startIso: string,
  endIsoInclusive: string,
  ctUserIdToKfi: Map<number, string>,
): Promise<ConnecteamPunch[]> {
  // Connecteam's date filter is exclusive of the upper bound, so push it +1d.
  const endParam = addDays(endIsoInclusive, 1);
  const out: ConnecteamPunch[] = [];

  for (const clockId of TIME_CLOCKS) {
    let url = `/time-clock/v1/time-clocks/${clockId}/time-activities?startDate=${startIso}&endDate=${endParam}&activityTypes=shift`;
    const data = (await ctFetch(url)) as {
      data?: { timeActivitiesByUsers?: Array<{ userId: number; shifts?: CtShift[] }> };
    };
    const shiftFix = SHUSTER_CLOCK_IDS.has(clockId) ? 3_600_000 : 0;
    const groups = data?.data?.timeActivitiesByUsers ?? [];
    for (const g of groups) {
      const ctUserId = g.userId;
      const aliasedKfi = USER_ID_ALIASES_LD[String(ctUserId)];
      const kfiId = aliasedKfi ?? ctUserIdToKfi.get(ctUserId);
      if (!kfiId) continue;
      const dispTz = IWG_DRIVER_IDS.has(kfiId) ? "America/New_York" : CT_TZ;
      for (const s of g.shifts ?? []) {
        const startTs = s.start?.timestamp;
        const endTs = s.end?.timestamp;
        if (!startTs || !endTs) continue;
        const rawStartMs = startTs * 1000 + shiftFix;
        const rawEndMs = endTs * 1000 + shiftFix;
        if (rawEndMs <= rawStartMs) continue;
        // Round each end to the nearest minute before computing duration so
        // the stored hours match what the dispatcher (and Connecteam itself)
        // sees on the minute-resolution wall-clock display. Computing hours
        // from second-precision raw timestamps used to drift by ~0.01–0.04
        // hours per shift versus what Connecteam shows the driver (e.g.
        // 5.43 vs 5.47), and the dashboard had no way to reconcile.
        const startMs = Math.round(rawStartMs / 60_000) * 60_000;
        const endMs = Math.round(rawEndMs / 60_000) * 60_000;
        if (endMs <= startMs) continue;
        const date = msToLocalDate(startMs, dispTz);
        // Skip anything that fell outside the requested window after tz-conv.
        if (date < startIso || date > endIsoInclusive) continue;
        out.push({
          kfiId,
          ctUserId,
          date,
          clockIn: msToLocalStr(startMs, dispTz),
          clockOut: msToLocalStr(endMs, dispTz),
          // Store as 2 decimals to match Connecteam's display rounding.
          hours: Math.round(((endMs - startMs) / 3_600_000) * 100) / 100,
          dispTz,
          // IMPORTANT: key on the RAW (second-precision) timestamps, not the
          // minute-rounded ones used for display/duration. Connecteam
          // returns the same raw values on every poll for the same shift,
          // so this key is stable. Anchoring it on the rounded values
          // would re-key existing rows the moment we changed the rounding
          // strategy, and the refresh-preserve-edited-rows logic would
          // see the new key as a different shift and insert a duplicate.
          ctExternalKey: `${ctUserId}:${rawStartMs}:${rawEndMs}`,
        });
      }
    }
  }
  return out;
}
