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
      return f.value == null ? undefined : String(f.value);
    }
  }
  return undefined;
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
      const customer = getCustomFieldValue(u, "customer") ?? "Unknown";
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
        const startMs = startTs * 1000 + shiftFix;
        const endMs = endTs * 1000 + shiftFix;
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
          hours: Math.round(((endMs - startMs) / 3_600_000) * 1000) / 1000,
          dispTz,
          ctExternalKey: `${ctUserId}:${startMs}:${endMs}`,
        });
      }
    }
  }
  return out;
}
