import { Router, type Request } from "express";
import { createHash } from "node:crypto";
import multer from "multer";
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  ConfirmCustomerFileBody,
  ConfirmNewCustomerFileBody,
  CreateDriverNoteBody,
  CreateManualPunchBody,
  CreateParserPromotionSnoozeBody,
  CreateDriverIdAliasBody,
  SetReviewedBody,
  UpdateCustomerNameAliasBody,
  UpdateDriverIdAliasBody,
} from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import {
  requireAuth,
  requireAdmin,
  requireSupervisorOrAdmin,
} from "../lib/auth.js";
import { assertNotLocked, loadLockedKfiIds } from "../lib/locks.js";
import {
  fetchAllTimeClocks,
  fetchAllUsers,
  fetchPunchesForWeek,
  looksLikeRosterDateJunk,
} from "../lib/connecteam.js";
import { EMBEDDED_MAPPING, TIME_CLOCKS } from "../lib/mappings.js";
import {
  computeChecks,
  computeDailyTotals,
  computeDriverTotals,
  defaultDispTz,
} from "../lib/hoursEngine.js";
import {
  loadDriverTz,
  loadDriverTzMap,
  resolveDispTz,
} from "../lib/dispatchTz.js";
import { buildDailyParity, summarizeParity } from "../lib/connecteamParity.js";
import {
  KNOWN_CUSTOMERS,
  detectAndParseFile,
} from "../lib/parsers/index.js";
import { detectCustomerFromFileName } from "../lib/parsers/customers.js";
import { aiExtractRows } from "../lib/parsers/aiExtract.js";
import { topMatches } from "../lib/parsers/fuzzy.js";
import {
  ALLOWED_TZS,
  diffHours,
  isAllowedTz,
  localStrToSortMs,
  sundayOf,
  weekEndOf,
} from "../lib/time.js";
import { toDisplayName } from "../lib/parsers/displayName.js";
import { makeTimesheetsHandler } from "../lib/timesheets.js";
import {
  publish as publishRealtime,
  subscribe as subscribeRealtime,
  upsertPresence,
  getPresence,
  startEditing,
  stopEditing,
  snapshot as realtimeSnapshot,
  type ActorRef,
} from "../lib/realtime.js";

function actorRef(req: Request): ActorRef | null {
  const user = (req as Request & { user?: { id: number; email: string } }).user;
  if (user) return { userId: user.id, email: user.email };
  return null;
}

async function loadMergedIdMap(): Promise<Record<string, string>> {
  const rows = await db
    .select({
      externalId: schema.driverIdAliasesTable.externalId,
      kfiId: schema.driverIdAliasesTable.kfiId,
    })
    .from(schema.driverIdAliasesTable);
  // Admin DB rows take precedence over the static map so an admin can also
  // override a stale embedded mapping without a code change.
  const merged: Record<string, string> = { ...EMBEDDED_MAPPING };
  for (const r of rows) merged[r.externalId] = r.kfiId;
  return merged;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export const weeksRouter = Router();

weeksRouter.use(requireAuth);

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const isWeek = (w: string) => WEEK_RE.test(w);

async function ensureWeek(weekStart: string): Promise<{
  startDate: string;
  endDate: string;
}> {
  const sunday = sundayOf(weekStart);
  const end = weekEndOf(sunday);
  await db
    .insert(schema.weeksTable)
    .values({ startDate: sunday, endDate: end })
    .onConflictDoNothing();
  return { startDate: sunday, endDate: end };
}

async function recordAttempt(
  weekStart: string,
  customer: string,
  fileName: string,
  error: string | null,
  source: "parser" | "ai",
  unmappedIds: schema.UnmappedIdEntry[] = [],
  contentHash: string | null = null,
): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.customerUploadAttemptsTable)
    .values({
      weekStart,
      customer,
      lastAttemptAt: now,
      lastSuccessAt: error ? null : now,
      lastFileName: fileName,
      lastError: error,
      lastSource: source,
      lastUnmappedIds: unmappedIds,
      // Only stamp the content hash on a successful import — a failed parse
      // is not "what's currently imported", so a subsequent re-upload of the
      // same bytes should still be attempted (it might now succeed after a
      // mapping fix).
      lastContentHash: error ? null : contentHash,
    })
    .onConflictDoUpdate({
      target: [
        schema.customerUploadAttemptsTable.weekStart,
        schema.customerUploadAttemptsTable.customer,
      ],
      set: {
        lastAttemptAt: now,
        lastSuccessAt: error
          ? sql`${schema.customerUploadAttemptsTable.lastSuccessAt}`
          : now,
        lastFileName: fileName,
        lastError: error,
        lastSource: source,
        lastUnmappedIds: unmappedIds,
        // Preserve any prior successful hash on a failed attempt — we want
        // skip-detection to still work against the last good import.
        lastContentHash: error
          ? sql`${schema.customerUploadAttemptsTable.lastContentHash}`
          : contentHash,
      },
    });
}

weeksRouter.get("/weeks", async (_req, res) => {
  const rows = await db
    .select({
      startDate: schema.weeksTable.startDate,
      endDate: schema.weeksTable.endDate,
      lastRefreshedAt: schema.weeksTable.lastRefreshedAt,
      driverCount: sql<number>`count(distinct ${schema.punchesTable.kfiId})::int`,
    })
    .from(schema.weeksTable)
    .leftJoin(
      schema.punchesTable,
      eq(schema.punchesTable.weekStart, schema.weeksTable.startDate),
    )
    .groupBy(
      schema.weeksTable.startDate,
      schema.weeksTable.endDate,
      schema.weeksTable.lastRefreshedAt,
    )
    .orderBy(desc(schema.weeksTable.startDate));
  res.json(
    rows.map((r) => ({
      startDate: r.startDate,
      endDate: r.endDate,
      lastRefreshedAt: r.lastRefreshedAt,
      driverCount: r.driverCount ?? 0,
    })),
  );
});

weeksRouter.get("/weeks/:weekStart/summary", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const week = await db.query.weeksTable.findFirst({
    where: eq(schema.weeksTable.startDate, weekStart),
  });
  const endDate = week?.endDate ?? weekEndOf(weekStart);

  const punches = await db
    .select()
    .from(schema.punchesTable)
    .where(eq(schema.punchesTable.weekStart, weekStart));
  // Pull every Connecteam daily snapshot for this week in one shot so we can
  // surface a per-driver parity status on the dashboard without N extra
  // requests. Grouped by kfiId below.
  const ctSnapshotRows = await db
    .select({
      kfiId: schema.connecteamDailySnapshotsTable.kfiId,
      date: schema.connecteamDailySnapshotsTable.date,
      hours: schema.connecteamDailySnapshotsTable.hours,
    })
    .from(schema.connecteamDailySnapshotsTable)
    .where(eq(schema.connecteamDailySnapshotsTable.weekStart, weekStart));
  const snapshotsByKfi = new Map<
    string,
    Array<{ date: string; hours: string | number }>
  >();
  for (const r of ctSnapshotRows) {
    const arr = snapshotsByKfi.get(r.kfiId) ?? [];
    arr.push({ date: r.date, hours: r.hours });
    snapshotsByKfi.set(r.kfiId, arr);
  }
  const deletions = await db
    .select()
    .from(schema.punchDeletionsTable)
    .where(eq(schema.punchDeletionsTable.weekStart, weekStart));
  const deletionsByKfi = new Map<string, (typeof deletions)[number]>();
  // Keep only the most recent delete per driver for last-touched purposes.
  for (const d of deletions) {
    const cur = deletionsByKfi.get(d.kfiId);
    if (!cur || new Date(d.deletedAt).getTime() > new Date(cur.deletedAt).getTime()) {
      deletionsByKfi.set(d.kfiId, d);
    }
  }
  const drivers = await db.select().from(schema.driversTable);
  const driverById = new Map(drivers.map((d) => [d.kfiId, d]));
  const reviewedRows = await db
    .select()
    .from(schema.reviewedDriversTable)
    .where(eq(schema.reviewedDriversTable.weekStart, weekStart));
  const reviewByKfi = new Map<
    string,
    {
      status: "good" | "bad" | null;
      lockedAt: Date | null;
      lockedByUserId: number | null;
    }
  >();
  for (const r of reviewedRows) {
    // Legacy back-compat: a row that exists with status NULL but no lock was
    // historically a "reviewed=true" row — treat it as 'good'.
    const status =
      r.status === "good" || r.status === "bad"
        ? r.status
        : r.lockedAt
          ? null
          : "good";
    reviewByKfi.set(r.kfiId, {
      status,
      lockedAt: r.lockedAt,
      lockedByUserId: r.lockedByUserId,
    });
  }
  const reviewed = new Set(
    reviewedRows
      .filter((r) =>
        // "Reviewed" for the print-filter / pill includes both good and bad.
        // (Treat any non-null status, OR a legacy null+unlocked row, as reviewed.)
        r.status === "good" ||
        r.status === "bad" ||
        (r.status == null && r.lockedAt == null),
      )
      .map((r) => r.kfiId),
  );

  // Resolve actor user emails for last-touched + last-refreshed surfacing.
  const actorIds = new Set<number>();
  if (week?.lastRefreshedBy) actorIds.add(week.lastRefreshedBy);
  for (const p of punches) {
    if (p.updatedBy) actorIds.add(p.updatedBy);
    if (p.createdBy) actorIds.add(p.createdBy);
    if (p.reviewedBy) actorIds.add(p.reviewedBy);
  }
  for (const d of deletions) {
    if (d.deletedBy) actorIds.add(d.deletedBy);
  }
  for (const r of reviewByKfi.values()) {
    if (r.lockedByUserId) actorIds.add(r.lockedByUserId);
  }

  // Note-count per driver for the week summary badge. Only non-deleted notes
  // count; both row-level (punch_id IS NOT NULL) and week-level (punch_id IS
  // NULL) are folded into a single per-driver tally.
  const noteCountRows = await db
    .select({
      kfiId: schema.driverNotesTable.kfiId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.driverNotesTable)
    .where(
      and(
        eq(schema.driverNotesTable.weekStart, weekStart),
        sql`${schema.driverNotesTable.deletedAt} IS NULL`,
      ),
    )
    .groupBy(schema.driverNotesTable.kfiId);
  const noteCountByKfi = new Map<string, number>();
  for (const r of noteCountRows) noteCountByKfi.set(r.kfiId, Number(r.count));
  const actorEmailById = new Map<number, string>();
  if (actorIds.size > 0) {
    const actorRows = await db
      .select({
        id: schema.usersTable.id,
        email: schema.usersTable.email,
      })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, [...actorIds]));
    for (const r of actorRows) actorEmailById.set(r.id, r.email);
  }
  const lastRefreshedByEmail = week?.lastRefreshedBy
    ? actorEmailById.get(week.lastRefreshedBy) ?? null
    : null;

  const byKfi = new Map<string, typeof punches>();
  for (const p of punches) {
    const arr = byKfi.get(p.kfiId) ?? [];
    arr.push(p);
    byKfi.set(p.kfiId, arr);
  }

  let totDriver = 0;
  let totCust = 0;
  let totRt = 0;
  let totOt = 0;
  interface SummaryRow {
    kfiId: string;
    name: string;
    customer: string;
    driverHours: number;
    customerHours: number;
    totalHours: number;
    regularHours: number;
    overtimeHours: number;
    reviewed: boolean;
    reviewStatus: "good" | "bad" | null;
    hasOvertime: boolean;
    locked: boolean;
    lockedByEmail: string | null;
    lastTouchedByEmail: string | null;
    lastTouchedAt: string | null;
    noteCount: number;
    displayTz: string | null;
    effectiveDispTz: string;
    connecteamParity: {
      status: "match" | "differ" | "unknown";
      diffCount: number;
    };
  }
  const rows: SummaryRow[] = [];
  for (const [kfiId, ps] of byKfi.entries()) {
    const t = computeDriverTotals(ps);
    if (t.totalHours <= 0) continue;
    const meta = driverById.get(kfiId);
    totDriver += t.totalDriver;
    totCust += t.totalCustomer;
    totRt += t.regularHours;
    totOt += t.overtimeHours;
    // "Last touched" = the most recently updated punch row for this driver.
    let mostRecent: (typeof ps)[number] | null = null;
    for (const p of ps) {
      if (
        !mostRecent ||
        new Date(p.updatedAt).getTime() >
          new Date(mostRecent.updatedAt).getTime()
      ) {
        mostRecent = p;
      }
    }
    let lastActorId =
      mostRecent?.updatedBy ?? mostRecent?.createdBy ?? null;
    let lastTouchedAt = mostRecent
      ? new Date(mostRecent.updatedAt).toISOString()
      : null;
    // Fold in the most recent delete event so a "last touched" trail
    // exists even after a manual punch is removed.
    const lastDelete = deletionsByKfi.get(kfiId);
    if (
      lastDelete &&
      (!lastTouchedAt ||
        new Date(lastDelete.deletedAt).getTime() >
          new Date(lastTouchedAt).getTime())
    ) {
      lastActorId = lastDelete.deletedBy ?? null;
      lastTouchedAt = new Date(lastDelete.deletedAt).toISOString();
    }
    const rstate = reviewByKfi.get(kfiId);
    // Compute parity using the same helpers the driver-detail view uses, so
    // the dashboard badge and the per-driver badge can never disagree.
    const dailyTotals = computeDailyTotals(ps, weekStart, endDate);
    const parityDays = buildDailyParity(
      dailyTotals,
      snapshotsByKfi.get(kfiId) ?? [],
      week?.lastRefreshedAt != null,
    );
    const paritySummary = summarizeParity(parityDays);
    rows.push({
      kfiId,
      name: meta?.name ?? `Driver ${kfiId}`,
      customer: meta?.customer ?? ps[0]?.customer ?? "Unknown",
      driverHours: t.totalDriver,
      customerHours: t.totalCustomer,
      totalHours: t.totalHours,
      regularHours: t.regularHours,
      overtimeHours: t.overtimeHours,
      reviewed: reviewed.has(kfiId),
      reviewStatus: rstate?.status ?? null,
      hasOvertime: t.hasOvertime,
      locked: !!rstate?.lockedAt,
      lockedByEmail: rstate?.lockedByUserId
        ? actorEmailById.get(rstate.lockedByUserId) ?? null
        : null,
      lastTouchedByEmail: lastActorId
        ? actorEmailById.get(lastActorId) ?? null
        : null,
      lastTouchedAt,
      noteCount: noteCountByKfi.get(kfiId) ?? 0,
      displayTz: meta?.displayTz ?? null,
      effectiveDispTz: resolveDispTz(kfiId, meta?.displayTz ?? null),
      connecteamParity: {
        status: paritySummary.status,
        diffCount: paritySummary.diffCount,
      },
    });
  }
  rows.sort(
    (a, b) =>
      a.customer.localeCompare(b.customer) || a.name.localeCompare(b.name),
  );
  // Group drivers by customer in a stable, dispatcher-friendly order:
  // KNOWN_CUSTOMERS first (matches the customer-files panel), then any extras
  // alphabetically, then a single "Needs roster cleanup" bucket for drivers
  // whose roster customer is missing, "Unknown", or date-shaped junk left
  // over from a corrupted Connecteam custom field.
  const UNASSIGNED = "Needs roster cleanup";
  const customerKey = (c: string) => {
    if (!c) return UNASSIGNED;
    const trimmed = c.trim();
    if (
      !trimmed ||
      trimmed === "Unknown" ||
      trimmed.toLowerCase() === "[object object]" ||
      looksLikeRosterDateJunk(trimmed)
    ) {
      return UNASSIGNED;
    }
    return c;
  };
  const knownOrder = new Map<string, number>(
    KNOWN_CUSTOMERS.map((c, i) => [c.displayName, i]),
  );
  const present = new Set(rows.map((r) => customerKey(r.customer)));
  const ordered: string[] = [];
  for (const c of KNOWN_CUSTOMERS) {
    if (present.has(c.displayName)) ordered.push(c.displayName);
  }
  const extras = [...present]
    .filter((c) => c !== UNASSIGNED && !knownOrder.has(c))
    .sort((a, b) => a.localeCompare(b));
  ordered.push(...extras);
  if (present.has(UNASSIGNED)) ordered.push(UNASSIGNED);
  const customers = ordered.map((customer) => ({
    customer,
    drivers: rows.filter((r) => customerKey(r.customer) === customer),
  }));

  res.json({
    startDate: weekStart,
    endDate,
    lastRefreshedAt: week?.lastRefreshedAt ?? null,
    lastRefreshedByEmail,
    totals: {
      activeDrivers: rows.length,
      driverHours: Math.round(totDriver * 1000) / 1000,
      customerHours: Math.round(totCust * 1000) / 1000,
      totalHours: Math.round((totDriver + totCust) * 1000) / 1000,
      regularHours: Math.round(totRt * 100) / 100,
      overtimeHours: Math.round(totOt * 100) / 100,
      goodCount: rows.filter((r) => r.reviewStatus === "good").length,
      badCount: rows.filter((r) => r.reviewStatus === "bad").length,
      lockedCount: rows.filter((r) => r.locked).length,
    },
    rows,
    customers,
  });
});

weeksRouter.get("/weeks/:weekStart/drivers/:kfiId", async (req, res) => {
  const weekStart = req.params.weekStart;
  const kfiId = req.params.kfiId;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const week = await db.query.weeksTable.findFirst({
    where: eq(schema.weeksTable.startDate, weekStart),
  });
  const endDate = week?.endDate ?? weekEndOf(weekStart);
  const driver = await db.query.driversTable.findFirst({
    where: eq(schema.driversTable.kfiId, kfiId),
  });
  const punches = await db
    .select()
    .from(schema.punchesTable)
    .where(
      and(
        eq(schema.punchesTable.weekStart, weekStart),
        eq(schema.punchesTable.kfiId, kfiId),
      ),
    )
    .orderBy(asc(schema.punchesTable.date), asc(schema.punchesTable.clockIn));
  if (!driver && punches.length === 0) {
    res.status(404).json({ error: "Driver not found" });
    return;
  }
  const totals = computeDriverTotals(punches);
  const dailyTotals = computeDailyTotals(punches, weekStart, endDate);
  // Pull the snapshotted Connecteam-side per-day totals so we can serve a
  // real numeric parity comparison (not just an edit-flag heuristic).
  const ctSnapshotRows = await db
    .select({
      date: schema.connecteamDailySnapshotsTable.date,
      hours: schema.connecteamDailySnapshotsTable.hours,
    })
    .from(schema.connecteamDailySnapshotsTable)
    .where(
      and(
        eq(schema.connecteamDailySnapshotsTable.weekStart, weekStart),
        eq(schema.connecteamDailySnapshotsTable.kfiId, kfiId),
      ),
    );
  // Baseline existence is driven by whether the WEEK has been refreshed,
  // not by whether any snapshot rows exist for this driver. A driver who
  // logged zero shifts in Connecteam still has a valid baseline (zero on
  // every day) once the week has been refreshed — and any manual punch
  // the dispatcher adds to that driver-week must surface as a diff.
  const baselineExists = week?.lastRefreshedAt != null;
  const dailyParity = buildDailyParity(
    dailyTotals,
    ctSnapshotRows,
    baselineExists,
  );
  const paritySummary = summarizeParity(dailyParity);
  const reviewed = await db.query.reviewedDriversTable.findFirst({
    where: and(
      eq(schema.reviewedDriversTable.weekStart, weekStart),
      eq(schema.reviewedDriversTable.kfiId, kfiId),
    ),
  });
  const actorIds = new Set<number>();
  for (const p of punches) {
    if (p.createdBy) actorIds.add(p.createdBy);
    if (p.updatedBy) actorIds.add(p.updatedBy);
    if (p.reviewedBy) actorIds.add(p.reviewedBy);
  }
  if (reviewed?.lockedByUserId) actorIds.add(reviewed.lockedByUserId);
  const actorEmailById = new Map<number, string>();
  if (actorIds.size > 0) {
    const actorRows = await db
      .select({
        id: schema.usersTable.id,
        email: schema.usersTable.email,
      })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, [...actorIds]));
    for (const r of actorRows) actorEmailById.set(r.id, r.email);
  }
  res.json({
    driver: {
      kfiId,
      name: driver?.name ?? `Driver ${kfiId}`,
      customer: driver?.customer ?? punches[0]?.customer ?? "Unknown",
      ctUserId: driver?.ctUserId ?? null,
      isDriver: driver?.isDriver ?? true,
      displayTz: driver?.displayTz ?? null,
      effectiveDispTz: resolveDispTz(kfiId, driver?.displayTz ?? null),
    },
    weekStart,
    endDate,
    punches: punches.map((p) => serializePunch(p, actorEmailById)),
    dailyTotals,
    connecteamParity: {
      status: paritySummary.status,
      diffCount: paritySummary.diffCount,
      lastRefreshedAt: week?.lastRefreshedAt
        ? new Date(week.lastRefreshedAt).toISOString()
        : null,
      days: dailyParity,
    },
    totals: {
      driverHours: totals.totalDriver,
      customerHours: totals.totalCustomer,
      totalHours: totals.totalHours,
      regularHours: totals.regularHours,
      overtimeHours: totals.overtimeHours,
      driverRt: totals.driverRt,
      driverOt: totals.driverOt,
      custRt: totals.custRt,
      custOt: totals.custOt,
    },
    checks: computeChecks(punches),
    reviewed: reviewed
      ? reviewed.status === "good" ||
        reviewed.status === "bad" ||
        (reviewed.status == null && reviewed.lockedAt == null)
      : false,
    reviewStatus:
      reviewed?.status === "good" || reviewed?.status === "bad"
        ? reviewed.status
        : reviewed && reviewed.lockedAt == null
          ? "good"
          : null,
    locked: !!reviewed?.lockedAt,
    lockedAt: reviewed?.lockedAt
      ? new Date(reviewed.lockedAt).toISOString()
      : null,
    lockedByEmail: reviewed?.lockedByUserId
      ? actorEmailById.get(reviewed.lockedByUserId) ?? null
      : null,
  });
});

weeksRouter.get(
  "/admin/connecteam/time-clocks-audit",
  requireAdmin,
  async (req, res) => {
    try {
      const clocks = await fetchAllTimeClocks();
      const configuredSet = new Set<number>(TIME_CLOCKS as readonly number[]);
      const discovered = clocks
        .map((c) => ({ ...c, configured: configuredSet.has(c.id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const discoveredIds = new Set(clocks.map((c) => c.id));
      res.json({
        discovered,
        missing: discovered.filter((c) => !c.configured),
        configuredButMissingFromAccount: [...configuredSet].filter(
          (id) => !discoveredIds.has(id),
        ),
      });
    } catch (err) {
      req.log.error({ err }, "Connecteam time-clocks audit failed");
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : "Connecteam error" });
    }
  },
);

weeksRouter.post("/weeks/:weekStart/refresh-connecteam", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const { startDate, endDate } = await ensureWeek(weekStart);
  try {
    const users = await fetchAllUsers();
    if (users.length > 0) {
      await db
        .insert(schema.driversTable)
        .values(
          users.map((u) => ({
            kfiId: u.kfiId,
            name: u.name,
            customer: u.customer,
            ctUserId: u.ctUserId,
            isDriver: u.isDriver,
            isArchived: u.isArchived,
          })),
        )
        .onConflictDoUpdate({
          target: schema.driversTable.kfiId,
          set: {
            name: sql`excluded.name`,
            customer: sql`excluded.customer`,
            ctUserId: sql`excluded.ct_user_id`,
            isDriver: sql`excluded.is_driver`,
            isArchived: sql`excluded.is_archived`,
            updatedAt: new Date(),
          },
        });
    }
    const ctUserIdToKfi = new Map(users.map((u) => [u.ctUserId, u.kfiId]));
    const driverTzByKfi = await loadDriverTzMap();
    const punches = await fetchPunchesForWeek(
      startDate,
      endDate,
      ctUserIdToKfi,
      driverTzByKfi,
    );
    // De-dupe by ctExternalKey before inserting to avoid mid-batch aborts.
    const uniqByKey = new Map<string, (typeof punches)[number]>();
    for (const p of punches) uniqByKey.set(p.ctExternalKey, p);
    const dedupedPunches = [...uniqByKey.values()];
    // Lock-gate: locked driver-weeks are frozen, so we never delete or
    // re-insert their Driver-source rows. Refresh otherwise proceeds for the
    // rest of the roster — locking one driver shouldn't block the week.
    const lockedKfiIds = await loadLockedKfiIds(startDate);
    const lockedSkipped: string[] = [];
    const refreshedAt = new Date();
    // Wrap delete + insert + week-update in a single transaction so a partial
    // failure never leaves the week with no driver punches.
    await db.transaction(async (tx) => {
      // Preserve manual rows AND any imported rows the dispatcher edited inline.
      // Also preserve everything for any driver whose week is locked.
      const deleteConds: SQL[] = [
        eq(schema.punchesTable.weekStart, startDate),
        eq(schema.punchesTable.source, "Driver"),
        eq(schema.punchesTable.isManual, false),
        ne(schema.punchesTable.edited, true),
      ];
      if (lockedKfiIds.size > 0) {
        deleteConds.push(
          sql`${schema.punchesTable.kfiId} NOT IN (${sql.join(
            [...lockedKfiIds].map((k) => sql`${k}`),
            sql`, `,
          )})`,
        );
      }
      await tx.delete(schema.punchesTable).where(and(...deleteConds));
      // Skip any inbound row whose ctExternalKey was kept (because it was edited).
      const keptKeys = new Set(
        (
          await tx
            .select({ key: schema.punchesTable.ctExternalKey })
            .from(schema.punchesTable)
            .where(
              and(
                eq(schema.punchesTable.weekStart, startDate),
                eq(schema.punchesTable.source, "Driver"),
              ),
            )
        )
          .map((r) => r.key)
          .filter((k): k is string => Boolean(k)),
      );
      const toInsert = dedupedPunches.filter((p) => {
        if (keptKeys.has(p.ctExternalKey)) return false;
        if (lockedKfiIds.has(p.kfiId)) {
          if (!lockedSkipped.includes(p.kfiId)) lockedSkipped.push(p.kfiId);
          return false;
        }
        return true;
      });
      if (toInsert.length > 0) {
        await tx.insert(schema.punchesTable).values(
          toInsert.map((p) => ({
            weekStart: startDate,
            kfiId: p.kfiId,
            customer: null,
            source: "Driver",
            date: p.date,
            clockIn: p.clockIn,
            clockOut: p.clockOut,
            hours: String(p.hours),
            dispTz: p.dispTz,
            isManual: false,
            ctExternalKey: p.ctExternalKey,
            createdBy: req.session.userId ?? null,
          })),
        );
      }
      // Snapshot Connecteam-side per-day totals so the driver-detail page can
      // render a real "matches Connecteam" parity badge (not just an
      // edit-flag heuristic). We use `dedupedPunches` — the raw Connecteam
      // payload — rather than what landed in the DB, because dispatcher
      // edits to imported rows are preserved on refresh and we want the
      // baseline to remain "what payroll would see if they pulled
      // Connecteam right now". Locked drivers are skipped: if their week is
      // frozen we don't update their baseline either.
      const snapshotByKey = new Map<
        string,
        { weekStart: string; kfiId: string; date: string; hours: number }
      >();
      for (const p of dedupedPunches) {
        if (lockedKfiIds.has(p.kfiId)) continue;
        const key = `${p.kfiId}|${p.date}`;
        const prev = snapshotByKey.get(key);
        if (prev) {
          prev.hours = Math.round((prev.hours + p.hours) * 100) / 100;
        } else {
          snapshotByKey.set(key, {
            weekStart: startDate,
            kfiId: p.kfiId,
            date: p.date,
            hours: Math.round(p.hours * 100) / 100,
          });
        }
      }
      // Wipe ALL prior snapshots for this week (except locked drivers, whose
      // baseline is frozen with their punches). This is intentionally
      // broader than `refreshedKfiIds` would be: a driver who used to have
      // Connecteam shifts but logged none in this refresh must have their
      // stale snapshot rows deleted, otherwise parity would compare the
      // dashboard against an outdated baseline. The re-insert below covers
      // every driver who DID have shifts; everyone else legitimately has no
      // baseline rows for this week and parity falls through to "Connecteam
      // = 0 for every day" (driven by week.lastRefreshedAt being non-null).
      const snapshotDeleteConds: SQL[] = [
        eq(schema.connecteamDailySnapshotsTable.weekStart, startDate),
      ];
      if (lockedKfiIds.size > 0) {
        snapshotDeleteConds.push(
          sql`${schema.connecteamDailySnapshotsTable.kfiId} NOT IN (${sql.join(
            [...lockedKfiIds].map((k) => sql`${k}`),
            sql`, `,
          )})`,
        );
      }
      await tx
        .delete(schema.connecteamDailySnapshotsTable)
        .where(and(...snapshotDeleteConds));
      const snapshotRows = [...snapshotByKey.values()].map((r) => ({
        weekStart: r.weekStart,
        kfiId: r.kfiId,
        date: r.date,
        hours: String(r.hours),
        refreshedAt,
      }));
      if (snapshotRows.length > 0) {
        await tx
          .insert(schema.connecteamDailySnapshotsTable)
          .values(snapshotRows);
      }
      await tx
        .update(schema.weeksTable)
        .set({
          lastRefreshedAt: refreshedAt,
          lastRefreshedBy: req.session.userId ?? null,
        })
        .where(eq(schema.weeksTable.startDate, startDate));
    });
    publishRealtime({
      type: "week-refreshed",
      weekStart: startDate,
      actor: actorRef(req),
    });
    res.json({
      driversFound: users.length,
      punchesUpserted: punches.length,
      refreshedAt: refreshedAt.toISOString(),
      lockedSkipped,
    });
  } catch (err) {
    req.log.error({ err }, "Connecteam refresh failed");
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : "Connecteam error" });
  }
});

weeksRouter.post(
  "/weeks/:weekStart/upload-customer-file",
  upload.single("file"),
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const { startDate } = await ensureWeek(weekStart);
    const drivers = await db.select().from(schema.driversTable);
    const kfiSet = new Set(drivers.map((d) => d.kfiId));
    const driverTzByKfi = new Map<string, string | null>(
      drivers.map((d) => [d.kfiId, d.displayTz ?? null]),
    );
    const fileName = req.file.originalname;
    const force =
      String(req.query.force ?? "").toLowerCase() === "1" ||
      String(req.query.force ?? "").toLowerCase() === "true";
    const contentHash = createHash("sha256")
      .update(req.file.buffer)
      .digest("hex");
    // Short-circuit no-op re-uploads: if the file's bytes exactly match the
    // most recent successful import for this (week, customer), skip parsing
    // and writing entirely. Detect customer from filename so we can look up
    // the prior attempt without parsing first.
    const detected = detectCustomerFromFileName(fileName);
    if (!force && detected) {
      const prior = await db
        .select({
          lastContentHash: schema.customerUploadAttemptsTable.lastContentHash,
          lastSuccessAt: schema.customerUploadAttemptsTable.lastSuccessAt,
        })
        .from(schema.customerUploadAttemptsTable)
        .where(
          and(
            eq(schema.customerUploadAttemptsTable.weekStart, startDate),
            eq(schema.customerUploadAttemptsTable.customer, detected),
          ),
        )
        .limit(1);
      const p = prior[0];
      if (p?.lastContentHash && p.lastSuccessAt && p.lastContentHash === contentHash) {
        res.json({
          customer: detected,
          fileName,
          punchesUpserted: 0,
          unmappedIds: [],
          lockedSkipped: [],
          skipped: true,
        });
        return;
      }
    }
    // Per-upload tz override sent as a multipart form field. Validated against
    // ALLOWED_TZS; anything unknown is dropped silently so a stale frontend
    // can't poison the data.
    const overrideTzRaw =
      typeof req.body?.dispTz === "string" ? req.body.dispTz.trim() : "";
    const overrideTz = isAllowedTz(overrideTzRaw) ? overrideTzRaw : null;
    let result;
    try {
      const idMap = await loadMergedIdMap();
      result = await detectAndParseFile(
        fileName,
        req.file.buffer,
        kfiSet,
        startDate,
        idMap,
      );
    } catch (err) {
      req.log.error({ err, fileName }, "Parse error");
      const msg = err instanceof Error ? err.message : "Could not parse file";
      // Best-effort: try to attribute to a known customer for status display.
      const detectedForErr = detectCustomerFromFileName(fileName);
      if (detectedForErr) {
        await recordAttempt(startDate, detectedForErr, fileName, msg, "parser");
      }
      res.status(400).json({ error: msg });
      return;
    }
    if (!result) {
      res.status(400).json({
        error:
          "Could not detect customer from filename. Include the customer name (penda, trienda, greystone, lsi, burnett, adient, iwg, delallo, zenople) in the file name.",
      });
      return;
    }
    if (result.punches.length === 0) {
      req.log.warn(
        { fileName, customer: result.customer },
        "Customer file parsed to zero punches",
      );
      const msg = `Detected customer "${result.customer}" but parsed 0 punches. The file format may have changed, or no rows match the loaded driver roster.`;
      await recordAttempt(startDate, result.customer, fileName, msg, "parser");
      res.status(400).json({ error: msg });
      return;
    }
    // Lock-gate: skip any rows belonging to a locked driver-week. Surface
    // them in the response so the dispatcher knows the upload was partial.
    const lockedKfiIds = await loadLockedKfiIds(startDate);
    const lockedSkipped: string[] = [];
    const insertablePunches = result.punches.filter((p) => {
      if (lockedKfiIds.has(p.kfiId)) {
        if (!lockedSkipped.includes(p.kfiId)) lockedSkipped.push(p.kfiId);
        return false;
      }
      return true;
    });
    // Transactional swap: delete the existing customer-source rows for this
    // (week, customer) and insert the new batch atomically.
    await db.transaction(async (tx) => {
      // Preserve manual rows AND inline-edited customer rows on re-upload.
      // Also preserve everything for locked driver-weeks.
      const deleteConds: SQL[] = [
        eq(schema.punchesTable.weekStart, startDate),
        eq(schema.punchesTable.source, "Customer"),
        eq(schema.punchesTable.customer, result.customer),
        eq(schema.punchesTable.isManual, false),
        ne(schema.punchesTable.edited, true),
      ];
      if (lockedKfiIds.size > 0) {
        deleteConds.push(
          sql`${schema.punchesTable.kfiId} NOT IN (${sql.join(
            [...lockedKfiIds].map((k) => sql`${k}`),
            sql`, `,
          )})`,
        );
      }
      await tx.delete(schema.punchesTable).where(and(...deleteConds));
      if (insertablePunches.length > 0) {
        await tx.insert(schema.punchesTable).values(
          insertablePunches.map((p) => ({
            weekStart: startDate,
            kfiId: p.kfiId,
            customer: result.customer,
            source: "Customer",
            date: p.date,
            clockIn: p.clockIn,
            clockOut: p.clockOut,
            hours: String(p.hours),
            payType: p.payType,
            dispTz: resolveDispTz(
              p.kfiId,
              driverTzByKfi.get(p.kfiId) ?? null,
              // For IWG, the parser sets noTz; resolveDispTz already covers
              // the IWG hardcode when no override/driver tz is set.
              overrideTz,
            ),
            isManual: false,
            fileOrigin: req.file!.originalname,
            createdBy: req.session.userId ?? null,
          })),
        );
      }
    });
    await recordAttempt(
      startDate,
      result.customer,
      fileName,
      null,
      "parser",
      result.unmappedIds,
      contentHash,
    );
    if (result.unmappedIds.length > 0) {
      req.log.warn(
        {
          fileName,
          customer: result.customer,
          unmappedIds: result.unmappedIds,
        },
        "Customer file contained badge IDs not in the KFI roster",
      );
    }
    publishRealtime({
      type: "customer-upload",
      weekStart: startDate,
      customer: result.customer,
      actor: actorRef(req),
    });
    res.json({
      customer: result.customer,
      fileName,
      punchesUpserted: insertablePunches.length,
      unmappedIds: result.unmappedIds,
      lockedSkipped,
    });
  },
);

// Two-step known-customer upload: extract (preview only) + confirm (writes).
// Mirrors the existing AI extract/confirm flow so dispatchers can review the
// parsed rows, exclude any that look wrong, and see exactly how many existing
// punches a re-upload will replace before anything is persisted.
weeksRouter.post(
  "/weeks/:weekStart/extract-customer-file",
  upload.single("file"),
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const { startDate } = await ensureWeek(weekStart);
    const drivers = await db.select().from(schema.driversTable);
    const kfiSet = new Set(drivers.map((d) => d.kfiId));
    const nameByKfi = new Map(drivers.map((d) => [d.kfiId, d.name] as const));
    const fileName = req.file.originalname;
    let result;
    try {
      const idMap = await loadMergedIdMap();
      result = await detectAndParseFile(
        fileName,
        req.file.buffer,
        kfiSet,
        startDate,
        idMap,
      );
    } catch (err) {
      req.log.error({ err, fileName }, "Parse error (extract)");
      const msg = err instanceof Error ? err.message : "Could not parse file";
      const detected = detectCustomerFromFileName(fileName);
      if (detected) {
        await recordAttempt(startDate, detected, fileName, msg, "parser");
      }
      res.status(400).json({ error: msg });
      return;
    }
    if (!result) {
      res.status(400).json({
        error:
          "Could not detect customer from filename. Include the customer name (penda, trienda, greystone, lsi, burnett, adient, iwg, delallo, zenople) in the file name.",
      });
      return;
    }
    if (result.punches.length === 0) {
      req.log.warn(
        { fileName, customer: result.customer },
        "Customer file parsed to zero punches (extract)",
      );
      const msg = `Detected customer "${result.customer}" but parsed 0 punches. The file format may have changed, or no rows match the loaded driver roster.`;
      await recordAttempt(startDate, result.customer, fileName, msg, "parser");
      res.status(400).json({ error: msg });
      return;
    }

    // Count existing customer-source rows for this (week, customer) that
    // /confirm-customer-file would actually replace. Mirrors the WHERE in
    // the wipe-and-reinsert tx exactly: skips manual rows, inline-edited
    // rows, and any rows belonging to a locked driver-week (all preserved
    // by the wipe). Otherwise the dispatcher would see an inflated
    // "will replace N existing rows" warning.
    const existingLockedKfiIds = await loadLockedKfiIds(startDate);
    const existingConds: SQL[] = [
      eq(schema.punchesTable.weekStart, startDate),
      eq(schema.punchesTable.source, "Customer"),
      eq(schema.punchesTable.customer, result.customer),
      eq(schema.punchesTable.isManual, false),
      ne(schema.punchesTable.edited, true),
    ];
    if (existingLockedKfiIds.size > 0) {
      existingConds.push(
        sql`${schema.punchesTable.kfiId} NOT IN (${sql.join(
          [...existingLockedKfiIds].map((k) => sql`${k}`),
          sql`, `,
        )})`,
      );
    }
    const existing = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.punchesTable)
      .where(and(...existingConds));
    const existingPunchCount = existing[0]?.n ?? 0;

    // Stash the original file bytes so /confirm-customer-file can re-parse
    // them deterministically. Unconfirmed samples expire after 24h; the
    // existing `aiExtractSampleCleanup` job already purges them.
    const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
    const [sample] = await db
      .insert(schema.aiExtractSamplesTable)
      .values({
        weekStart: startDate,
        customer: result.customer,
        fileName,
        mimeType: req.file.mimetype || "application/octet-stream",
        sizeBytes: req.file.size,
        fileBytes: req.file.buffer,
        uploadedBy: req.session.userId ?? null,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      })
      .returning({ id: schema.aiExtractSamplesTable.id });

    res.json({
      customer: result.customer,
      fileName,
      weekStart: startDate,
      sampleId: sample.id,
      rows: result.punches.map((p, index) => ({
        index,
        // Source row hint: the parser preserves the document's row order,
        // so the 1-based position plus filename is enough for a dispatcher
        // to find the matching line in the original file.
        sourceRow: `row ${index + 1} of ${fileName}`,
        kfiId: p.kfiId,
        driverName: nameByKfi.get(p.kfiId) ?? null,
        date: p.date,
        clockIn: p.clockIn,
        clockOut: p.clockOut,
        hours: p.hours,
        payType: p.payType,
      })),
      unmappedIds: result.unmappedIds,
      existingPunchCount,
    });
  },
);

weeksRouter.post(
  "/weeks/:weekStart/confirm-customer-file",
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    const parsed = ConfirmCustomerFileBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }
    const { startDate } = await ensureWeek(weekStart);
    const customer = parsed.data.customer.trim();
    if (!customer) {
      res.status(400).json({ error: "Customer name is required" });
      return;
    }
    const excludedIndices = new Set(parsed.data.excludedIndices ?? []);

    // Load the stashed sample. We require (id, weekStart, customer) to match
    // so a stale or unrelated sampleId can't be used to commit against the
    // wrong week or customer.
    const [sample] = await db
      .select()
      .from(schema.aiExtractSamplesTable)
      .where(
        and(
          eq(schema.aiExtractSamplesTable.id, parsed.data.sampleId),
          eq(schema.aiExtractSamplesTable.weekStart, startDate),
          eq(schema.aiExtractSamplesTable.customer, customer),
        ),
      )
      .limit(1);
    if (!sample) {
      res.status(400).json({
        error:
          "Upload preview not found. The stashed file may have expired — re-upload the customer file to start over.",
      });
      return;
    }

    const drivers = await db.select().from(schema.driversTable);
    const kfiSet = new Set(drivers.map((d) => d.kfiId));
    const fileName = sample.fileName;
    let result;
    try {
      const idMap = await loadMergedIdMap();
      result = await detectAndParseFile(
        fileName,
        Buffer.from(sample.fileBytes),
        kfiSet,
        startDate,
        idMap,
      );
    } catch (err) {
      req.log.error({ err, fileName }, "Parse error (confirm)");
      const msg = err instanceof Error ? err.message : "Could not parse file";
      await recordAttempt(startDate, customer, fileName, msg, "parser");
      res.status(400).json({ error: msg });
      return;
    }
    if (!result || result.customer !== customer) {
      const msg = "Stashed file no longer parses to the expected customer.";
      await recordAttempt(startDate, customer, fileName, msg, "parser");
      res.status(400).json({ error: msg });
      return;
    }

    // Apply the dispatcher's exclude toggles using the same deterministic
    // index order the preview returned.
    const includedPunches = result.punches.filter(
      (_p, i) => !excludedIndices.has(i),
    );

    // Lock-gate: skip any rows belonging to a locked driver-week. Same
    // semantics as the legacy single-shot upload route.
    const lockedKfiIds = await loadLockedKfiIds(startDate);
    const lockedSkipped: string[] = [];
    const insertablePunches = includedPunches.filter((p) => {
      if (lockedKfiIds.has(p.kfiId)) {
        if (!lockedSkipped.includes(p.kfiId)) lockedSkipped.push(p.kfiId);
        return false;
      }
      return true;
    });

    await db.transaction(async (tx) => {
      const deleteConds: SQL[] = [
        eq(schema.punchesTable.weekStart, startDate),
        eq(schema.punchesTable.source, "Customer"),
        eq(schema.punchesTable.customer, result.customer),
        eq(schema.punchesTable.isManual, false),
        ne(schema.punchesTable.edited, true),
      ];
      if (lockedKfiIds.size > 0) {
        deleteConds.push(
          sql`${schema.punchesTable.kfiId} NOT IN (${sql.join(
            [...lockedKfiIds].map((k) => sql`${k}`),
            sql`, `,
          )})`,
        );
      }
      await tx.delete(schema.punchesTable).where(and(...deleteConds));
      if (insertablePunches.length > 0) {
        await tx.insert(schema.punchesTable).values(
          insertablePunches.map((p) => ({
            weekStart: startDate,
            kfiId: p.kfiId,
            customer: result.customer,
            source: "Customer",
            date: p.date,
            clockIn: p.clockIn,
            clockOut: p.clockOut,
            hours: String(p.hours),
            payType: p.payType,
            dispTz: p.noTz ? "America/New_York" : defaultDispTz(p.kfiId),
            isManual: false,
            fileOrigin: fileName,
            createdBy: req.session.userId ?? null,
          })),
        );
      }
      // Purge the stashed bytes inside the same tx as the commit. A
      // sample is only useful as a "pending preview" — once it's been
      // confirmed (or rolled back), we have no reason to hold the
      // payroll file around. Symmetric with the discard-on-cancel path.
      await tx
        .delete(schema.aiExtractSamplesTable)
        .where(eq(schema.aiExtractSamplesTable.id, sample.id));
    });

    await recordAttempt(
      startDate,
      result.customer,
      fileName,
      null,
      "parser",
      result.unmappedIds,
    );
    if (result.unmappedIds.length > 0) {
      req.log.warn(
        {
          fileName,
          customer: result.customer,
          unmappedIds: result.unmappedIds,
        },
        "Customer file contained badge IDs not in the KFI roster",
      );
    }
    res.json({
      customer: result.customer,
      fileName,
      punchesUpserted: insertablePunches.length,
      unmappedIds: result.unmappedIds,
      lockedSkipped,
    });
  },
);

// Discard a stashed extract preview without committing. Called when the
// dispatcher cancels the preview dialog so we don't keep payroll-file
// bytes around for the full 24h TTL when we know they'll never be used.
// Idempotent: missing sample is treated as success (already gone).
weeksRouter.delete(
  "/weeks/:weekStart/extract-customer-file/:sampleId",
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    const sampleId = Number.parseInt(String(req.params.sampleId ?? ""), 10);
    if (!Number.isFinite(sampleId)) {
      res.status(400).json({ error: "Invalid sampleId" });
      return;
    }
    const { startDate } = await ensureWeek(weekStart);
    await db
      .delete(schema.aiExtractSamplesTable)
      .where(
        and(
          eq(schema.aiExtractSamplesTable.id, sampleId),
          eq(schema.aiExtractSamplesTable.weekStart, startDate),
        ),
      );
    res.status(204).end();
  },
);

weeksRouter.get("/weeks/:weekStart/customer-uploads", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const rows = await db
    .select({
      customer: schema.punchesTable.customer,
      punchCount: sql<number>`count(*)::int`,
      lastUploadAt: sql<Date | null>`max(${schema.punchesTable.createdAt})`,
      lastFileName: sql<string | null>`(
        array_agg(${schema.punchesTable.fileOrigin} order by ${schema.punchesTable.createdAt} desc)
        filter (where ${schema.punchesTable.fileOrigin} is not null)
      )[1]`,
    })
    .from(schema.punchesTable)
    .where(
      and(
        eq(schema.punchesTable.weekStart, weekStart),
        eq(schema.punchesTable.source, "Customer"),
        eq(schema.punchesTable.isManual, false),
      ),
    )
    .groupBy(schema.punchesTable.customer);
  const attempts = await db
    .select()
    .from(schema.customerUploadAttemptsTable)
    .where(eq(schema.customerUploadAttemptsTable.weekStart, weekStart));
  // Count distinct AI-import weeks per customer across all time so we can
  // surface a "promote to parser" hint when the same customer keeps coming
  // through the AI flow.
  const aiWeekRows = await db
    .select({
      customer: schema.customerUploadAttemptsTable.customer,
      weekCount: sql<number>`count(distinct ${schema.customerUploadAttemptsTable.weekStart})::int`,
    })
    .from(schema.customerUploadAttemptsTable)
    .where(eq(schema.customerUploadAttemptsTable.lastSource, "ai"))
    .groupBy(schema.customerUploadAttemptsTable.customer);
  const aiWeekCountByCustomer = new Map(
    aiWeekRows.map((r) => [r.customer, r.weekCount ?? 0]),
  );
  // Count saved driver-name aliases per customer. A growing alias count is a
  // strong signal that the customer is a recurring weekly run, not a one-off,
  // and that it's worth promoting them to a deterministic parser.
  const aliasRows = await db
    .select({
      customer: schema.customerNameAliasesTable.customer,
      aliasCount: sql<number>`count(*)::int`,
    })
    .from(schema.customerNameAliasesTable)
    .groupBy(schema.customerNameAliasesTable.customer);
  const aliasCountByCustomer = new Map(
    aliasRows.map((r) => [r.customer, r.aliasCount ?? 0]),
  );
  // Look up active snoozes (snoozedUntil is null or in the future) so we can
  // suppress promotionCandidate for any customer the admins have chosen to
  // ignore. Compared case-insensitively to match the unique index.
  const snoozeRows = await db
    .select({
      customer: schema.parserPromotionSnoozesTable.customer,
      snoozedUntil: schema.parserPromotionSnoozesTable.snoozedUntil,
    })
    .from(schema.parserPromotionSnoozesTable);
  const now = Date.now();
  const snoozedSet = new Set<string>();
  for (const s of snoozeRows) {
    if (
      s.snoozedUntil == null ||
      new Date(s.snoozedUntil).getTime() > now
    ) {
      snoozedSet.add(s.customer.toLowerCase());
    }
  }
  const isSnoozed = (name: string) => snoozedSet.has(name.toLowerCase());
  const isPromotionCandidate = (
    aiWeeks: number,
    aliases: number,
    name: string,
  ) => (aiWeeks >= 3 || aliases >= 5) && !isSnoozed(name);
  const tzPrefRows = await db
    .select({
      customer: schema.customerTzPreferencesTable.customer,
      displayTz: schema.customerTzPreferencesTable.displayTz,
    })
    .from(schema.customerTzPreferencesTable);
  const tzPrefByLower = new Map<string, string>();
  for (const r of tzPrefRows) {
    if (isAllowedTz(r.displayTz)) tzPrefByLower.set(r.customer.toLowerCase(), r.displayTz);
  }
  const prefFor = (name: string): string | null =>
    tzPrefByLower.get(name.toLowerCase()) ?? null;
  const knownNames = new Set(KNOWN_CUSTOMERS.map((c) => c.displayName));
  const byName = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.customer) byName.set(r.customer, r);
  }
  const attemptByName = new Map(attempts.map((a) => [a.customer, a]));
  const out = KNOWN_CUSTOMERS.map((c) => {
    const r = byName.get(c.displayName);
    const a = attemptByName.get(c.displayName);
    return {
      customer: c.displayName,
      extensions: [...c.extensions],
      keywords: [...c.keywords],
      punchCount: r?.punchCount ?? 0,
      lastUploadAt: r?.lastUploadAt
        ? new Date(r.lastUploadAt).toISOString()
        : null,
      lastFileName: r?.lastFileName ?? a?.lastFileName ?? null,
      lastAttemptAt: a?.lastAttemptAt
        ? new Date(a.lastAttemptAt).toISOString()
        : null,
      lastSuccessAt: a?.lastSuccessAt
        ? new Date(a.lastSuccessAt).toISOString()
        : null,
      lastError: a?.lastError ?? null,
      lastSource: a?.lastSource ?? null,
      lastUnmappedIds: a?.lastUnmappedIds ?? [],
      isAiImported: false,
      aiImportWeekCount: aiWeekCountByCustomer.get(c.displayName) ?? 0,
      aliasCount: aliasCountByCustomer.get(c.displayName) ?? 0,
      // Known-customer rows already have a deterministic parser, so they
      // never need promoting. Keep promotionCandidate=false unconditionally.
      promotionCandidate: false,
      preferredDispTz: prefFor(c.displayName),
    };
  });
  // Append any AI-only customers that aren't in KNOWN_CUSTOMERS so the
  // dispatcher can re-upload (via the AI flow) and engineers can see how
  // often each candidate has been hand-imported.
  const aiOnlyNames = new Set<string>();
  for (const r of rows) {
    if (r.customer && !knownNames.has(r.customer)) aiOnlyNames.add(r.customer);
  }
  for (const a of attempts) {
    if (a.lastSource === "ai" && !knownNames.has(a.customer)) {
      aiOnlyNames.add(a.customer);
    }
  }
  const aiOnly = [...aiOnlyNames].sort().map((name) => {
    const r = byName.get(name);
    const a = attemptByName.get(name);
    return {
      customer: name,
      extensions: ["pdf", "xlsx"],
      keywords: [],
      punchCount: r?.punchCount ?? 0,
      lastUploadAt: r?.lastUploadAt
        ? new Date(r.lastUploadAt).toISOString()
        : null,
      lastFileName: r?.lastFileName ?? a?.lastFileName ?? null,
      lastAttemptAt: a?.lastAttemptAt
        ? new Date(a.lastAttemptAt).toISOString()
        : null,
      lastSuccessAt: a?.lastSuccessAt
        ? new Date(a.lastSuccessAt).toISOString()
        : null,
      lastError: a?.lastError ?? null,
      lastSource: a?.lastSource ?? "ai",
      lastUnmappedIds: a?.lastUnmappedIds ?? [],
      isAiImported: true,
      aiImportWeekCount: aiWeekCountByCustomer.get(name) ?? 0,
      aliasCount: aliasCountByCustomer.get(name) ?? 0,
      promotionCandidate: isPromotionCandidate(
        aiWeekCountByCustomer.get(name) ?? 0,
        aliasCountByCustomer.get(name) ?? 0,
        name,
      ),
      preferredDispTz: prefFor(name),
    };
  });
  res.json([...out, ...aiOnly]);
});

weeksRouter.get(
  "/parser-promotion-snoozes",
  requireAdmin,
  async (_req, res) => {
    const rows = await db
      .select({
        customer: schema.parserPromotionSnoozesTable.customer,
        snoozedAt: schema.parserPromotionSnoozesTable.snoozedAt,
        snoozedUntil: schema.parserPromotionSnoozesTable.snoozedUntil,
        snoozedByUserId: schema.parserPromotionSnoozesTable.snoozedByUserId,
        reason: schema.parserPromotionSnoozesTable.reason,
      })
      .from(schema.parserPromotionSnoozesTable)
      .orderBy(desc(schema.parserPromotionSnoozesTable.snoozedAt));
    const actorIds = new Set<number>();
    for (const r of rows) if (r.snoozedByUserId) actorIds.add(r.snoozedByUserId);
    const emailById = new Map<number, string>();
    if (actorIds.size > 0) {
      const actors = await db
        .select({ id: schema.usersTable.id, email: schema.usersTable.email })
        .from(schema.usersTable)
        .where(inArray(schema.usersTable.id, [...actorIds]));
      for (const a of actors) emailById.set(a.id, a.email);
    }
    res.json(
      rows.map((r) => ({
        customer: r.customer,
        snoozedAt: new Date(r.snoozedAt).toISOString(),
        snoozedUntil: r.snoozedUntil
          ? new Date(r.snoozedUntil).toISOString()
          : null,
        snoozedByEmail: r.snoozedByUserId
          ? emailById.get(r.snoozedByUserId) ?? null
          : null,
        reason: r.reason ?? null,
      })),
    );
  },
);

weeksRouter.post(
  "/parser-promotion-snoozes",
  requireAdmin,
  async (req, res) => {
    const parsed = CreateParserPromotionSnoozeBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }
    const customer = parsed.data.customer.trim();
    if (!customer) {
      res.status(400).json({ error: "customer is required" });
      return;
    }
    const snoozeWeeks = parsed.data.snoozeWeeks ?? null;
    const snoozedUntil =
      snoozeWeeks && snoozeWeeks > 0
        ? new Date(Date.now() + snoozeWeeks * 7 * 24 * 60 * 60 * 1000)
        : null;
    const snoozedAt = new Date();
    const reason = parsed.data.reason?.trim() || null;
    // Upsert by case-insensitive customer. The unique index is on lower(customer);
    // delete-then-insert keeps the upsert simple regardless of casing drift.
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.parserPromotionSnoozesTable)
        .where(
          sql`lower(${schema.parserPromotionSnoozesTable.customer}) = lower(${customer})`,
        );
      await tx.insert(schema.parserPromotionSnoozesTable).values({
        customer,
        snoozedAt,
        snoozedUntil,
        snoozedByUserId: req.session.userId ?? null,
        reason,
      });
      await tx.insert(schema.userAuditLogTable).values({
        actorUserId: req.session.userId ?? null,
        targetUserId: null,
        targetEmail: `parser-snooze:${customer}|until=${
          snoozedUntil ? snoozedUntil.toISOString() : "forever"
        }`,
        action: "parser-snooze",
      });
    });
    let snoozedByEmail: string | null = null;
    if (req.session.userId) {
      const actor = await db.query.usersTable.findFirst({
        where: eq(schema.usersTable.id, req.session.userId),
        columns: { email: true },
      });
      snoozedByEmail = actor?.email ?? null;
    }
    res.json({
      customer,
      snoozedAt: snoozedAt.toISOString(),
      snoozedUntil: snoozedUntil ? snoozedUntil.toISOString() : null,
      snoozedByEmail,
      reason,
    });
  },
);

weeksRouter.delete(
  "/parser-promotion-snoozes",
  requireAdmin,
  async (req, res) => {
    const customer = String(req.query.customer ?? "").trim();
    if (!customer) {
      res.status(400).json({ error: "customer is required" });
      return;
    }
    await db.transaction(async (tx) => {
      const removed = await tx
        .delete(schema.parserPromotionSnoozesTable)
        .where(
          sql`lower(${schema.parserPromotionSnoozesTable.customer}) = lower(${customer})`,
        )
        .returning({ customer: schema.parserPromotionSnoozesTable.customer });
      if (removed.length === 0) return;
      await tx.insert(schema.userAuditLogTable).values({
        actorUserId: req.session.userId ?? null,
        targetUserId: null,
        targetEmail: `parser-snooze:${removed[0].customer}`,
        action: "parser-snooze-lift",
      });
    });
    res.status(204).end();
  },
);

weeksRouter.post(
  "/weeks/:weekStart/extract-new-customer",
  upload.single("file"),
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const customer = String(req.body?.customer ?? "").trim();
    if (!customer) {
      res.status(400).json({ error: "Customer name is required" });
      return;
    }
    const lower = req.file.originalname.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
      res.status(400).json({ error: "Only .pdf and .xlsx files are supported" });
      return;
    }
    const { startDate, endDate } = await ensureWeek(weekStart);
    let rows;
    try {
      rows = await aiExtractRows(
        req.file.originalname,
        req.file.buffer,
        customer,
        startDate,
        endDate,
      );
    } catch (err) {
      req.log.error({ err, fileName: req.file.originalname }, "AI extract error");
      res.status(400).json({
        error: err instanceof Error ? err.message : "Could not extract rows",
      });
      return;
    }
    // Filter to the requested week window — the model is told but doesn't
    // always obey, so we hard-clamp here.
    rows = rows.filter((r) => r.date >= startDate && r.date <= endDate);
    if (rows.length === 0) {
      res.status(400).json({
        error: `Could not find any punch rows in this file for the week of ${startDate}.`,
      });
      return;
    }
    // Stash the original upload so an engineer can later use it as a fixture
    // when promoting this customer to a deterministic parser. Unconfirmed
    // samples expire after 24h; confirmed ones are bumped to 90 days when
    // /confirm-new-customer fires.
    const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
    const [sample] = await db
      .insert(schema.aiExtractSamplesTable)
      .values({
        weekStart: startDate,
        customer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype || "application/octet-stream",
        sizeBytes: req.file.size,
        fileBytes: req.file.buffer,
        uploadedBy: req.session.userId ?? null,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      })
      .returning({ id: schema.aiExtractSamplesTable.id });
    const drivers = await db
      .select({
        kfiId: schema.driversTable.kfiId,
        name: schema.driversTable.name,
        customer: schema.driversTable.customer,
      })
      .from(schema.driversTable)
      .where(eq(schema.driversTable.isArchived, false));
    const seen = new Map<string, string | null>();
    for (const r of rows) {
      const key = r.driverNameOnDoc.trim();
      if (!seen.has(key)) seen.set(key, r.badgeOrId ?? null);
    }
    // Pull every saved alias for this customer so we can pre-fill the
    // dispatcher's dropdown for names they've decided on before. We match
    // case-insensitively to forgive minor casing drift in the source doc.
    const savedAliases = await db
      .select({
        nameOnDoc: schema.customerNameAliasesTable.nameOnDoc,
        kfiId: schema.customerNameAliasesTable.kfiId,
      })
      .from(schema.customerNameAliasesTable)
      .where(
        sql`lower(${schema.customerNameAliasesTable.customer}) = lower(${customer})`,
      );
    const validKfi = new Set(drivers.map((d) => d.kfiId));
    const aliasByLowerName = new Map<string, string>();
    for (const a of savedAliases) {
      if (validKfi.has(a.kfiId)) {
        aliasByLowerName.set(a.nameOnDoc.toLowerCase(), a.kfiId);
      }
    }
    const suggestions = [...seen.entries()].map(([driverNameOnDoc, badgeOrId]) => {
      const matches = topMatches(driverNameOnDoc, drivers, 5);
      const savedKfiId =
        aliasByLowerName.get(driverNameOnDoc.toLowerCase()) ?? null;
      // If the saved driver isn't already in the top-N matches, surface them
      // at the top so the dropdown can render that option.
      if (savedKfiId && !matches.some((m) => m.kfiId === savedKfiId)) {
        const driver = drivers.find((d) => d.kfiId === savedKfiId);
        if (driver) {
          matches.unshift({
            kfiId: driver.kfiId,
            name: driver.name,
            customer: driver.customer,
            confidence: 1,
          });
        }
      }
      return { driverNameOnDoc, badgeOrId, savedKfiId, matches };
    });
    res.json({
      customer,
      weekStart: startDate,
      rows,
      suggestions,
      sampleId: sample.id,
    });
  },
);

weeksRouter.post("/weeks/:weekStart/confirm-new-customer", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const parsed = ConfirmNewCustomerFileBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { startDate, endDate } = await ensureWeek(weekStart);
  const customer = parsed.data.customer.trim();
  if (!customer) {
    res.status(400).json({ error: "Customer name is required" });
    return;
  }
  const overrideTzRaw =
    typeof parsed.data.dispTz === "string" ? parsed.data.dispTz.trim() : "";
  const overrideTz = isAllowedTz(overrideTzRaw) ? overrideTzRaw : null;
  const driverTzByKfi = await loadDriverTzMap();

  const unmappedNames = new Set<string>();
  const lockedKfiIds = await loadLockedKfiIds(startDate);
  const lockedSkipped: string[] = [];
  const toInsert: Array<{
    kfiId: string;
    date: string;
    clockIn: string;
    clockOut: string;
    hours: number;
    dispTz: string;
  }> = [];
  let skipped = 0;
  for (const r of parsed.data.rows) {
    if (r.date < startDate || r.date > endDate) {
      skipped++;
      continue;
    }
    const kfiId = parsed.data.mapping[r.driverNameOnDoc] ?? null;
    if (!kfiId) {
      unmappedNames.add(r.driverNameOnDoc);
      skipped++;
      continue;
    }
    if (lockedKfiIds.has(kfiId)) {
      if (!lockedSkipped.includes(kfiId)) lockedSkipped.push(kfiId);
      skipped++;
      continue;
    }
    let hours = r.hours ?? 0;
    if (!hours) {
      const ms =
        new Date(`${r.date} ${r.clockOut}`).getTime() -
        new Date(`${r.date} ${r.clockIn}`).getTime();
      if (!isNaN(ms) && ms > 0) hours = Math.round((ms / 3_600_000) * 1000) / 1000;
    }
    if (!(hours > 0)) {
      skipped++;
      continue;
    }
    toInsert.push({
      kfiId,
      date: r.date,
      clockIn: `${r.date} ${r.clockIn}`,
      clockOut: `${r.date} ${r.clockOut}`,
      hours: Math.round(hours * 1000) / 1000,
      dispTz: resolveDispTz(
        kfiId,
        driverTzByKfi.get(kfiId) ?? null,
        overrideTz,
      ),
    });
  }

  // Distinct (nameOnDoc → kfiId) pairs we want to remember for next week.
  // We only persist non-null mappings; "Skip" leaves any prior alias intact
  // so a single accidental skip doesn't erase a learned decision. The
  // dispatcher uses the explicit "forget" link to undo a saved alias.
  const aliasUpserts = new Map<string, { nameOnDoc: string; kfiId: string }>();
  for (const [rawName, kfiId] of Object.entries(parsed.data.mapping)) {
    // Store the alias in Title Case so future dropdowns / admin pages
    // render cleanly even if the source doc was ALL-CAPS. Case-insensitive
    // uniqueness still holds via the `lower(name_on_doc)` index.
    const nameOnDoc = toDisplayName(rawName.trim());
    if (!nameOnDoc || !kfiId) continue;
    aliasUpserts.set(nameOnDoc.toLowerCase(), { nameOnDoc, kfiId });
  }

  await db.transaction(async (tx) => {
    const deleteConds: SQL[] = [
      eq(schema.punchesTable.weekStart, startDate),
      eq(schema.punchesTable.source, "Customer"),
      eq(schema.punchesTable.customer, customer),
      eq(schema.punchesTable.isManual, false),
      ne(schema.punchesTable.edited, true),
    ];
    if (lockedKfiIds.size > 0) {
      deleteConds.push(
        sql`${schema.punchesTable.kfiId} NOT IN (${sql.join(
          [...lockedKfiIds].map((k) => sql`${k}`),
          sql`, `,
        )})`,
      );
    }
    await tx.delete(schema.punchesTable).where(and(...deleteConds));
    if (toInsert.length > 0) {
      await tx.insert(schema.punchesTable).values(
        toInsert.map((p) => ({
          weekStart: startDate,
          kfiId: p.kfiId,
          customer,
          source: "Customer",
          date: p.date,
          clockIn: p.clockIn,
          clockOut: p.clockOut,
          hours: String(p.hours),
          payType: "Reg",
          dispTz: p.dispTz,
          isManual: false,
          fileOrigin: `ai:${customer}`,
          createdBy: req.session.userId ?? null,
        })),
      );
    }
    for (const { nameOnDoc, kfiId } of aliasUpserts.values()) {
      // Replace any existing alias for this case-insensitive (customer, name)
      // before inserting; Drizzle's onConflict needs an explicit unique target
      // and our index is on `lower(...)` so we can't reference it directly.
      await tx
        .delete(schema.customerNameAliasesTable)
        .where(
          and(
            sql`lower(${schema.customerNameAliasesTable.customer}) = lower(${customer})`,
            sql`lower(${schema.customerNameAliasesTable.nameOnDoc}) = lower(${nameOnDoc})`,
          ),
        );
      await tx.insert(schema.customerNameAliasesTable).values({
        customer,
        nameOnDoc,
        kfiId,
        updatedBy: req.session.userId ?? null,
      });
    }
  });

  await recordAttempt(
    startDate,
    customer,
    `ai:${customer}`,
    toInsert.length === 0
      ? `AI extract confirmed but 0 rows imported (${skipped} skipped — ${[...unmappedNames].join(", ") || "incomplete rows"})`
      : null,
    "ai",
  );

  // Mark the stashed file as confirmed and bump retention so an engineer
  // can grab it as a fixture when promoting this customer to a parser.
  // We require the sample's customer + week to match the confirmation so a
  // stale or unrelated sampleId can't accidentally extend retention on the
  // wrong file.
  if (parsed.data.sampleId != null) {
    const CONFIRMED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
    const result = await db
      .update(schema.aiExtractSamplesTable)
      .set({
        confirmedAt: new Date(),
        expiresAt: new Date(Date.now() + CONFIRMED_TTL_MS),
      })
      .where(
        and(
          eq(schema.aiExtractSamplesTable.id, parsed.data.sampleId),
          eq(schema.aiExtractSamplesTable.weekStart, weekStart),
          eq(schema.aiExtractSamplesTable.customer, customer),
        ),
      )
      .returning({ id: schema.aiExtractSamplesTable.id });
    if (result.length === 0) {
      req.log.warn(
        {
          sampleId: parsed.data.sampleId,
          weekStart,
          customer,
        },
        "confirm-new-customer: sampleId did not match weekStart+customer, skipping retention bump",
      );
    }
  }

  publishRealtime({
    type: "customer-upload",
    weekStart: startDate,
    customer,
    actor: actorRef(req),
  });
  res.json({
    customer,
    imported: toInsert.length,
    skippedUnmapped: skipped,
    unmappedNames: [...unmappedNames],
    lockedSkipped,
  });
});

weeksRouter.get(
  "/admin/ai-extract-samples",
  requireAdmin,
  async (req, res) => {
    const customer = typeof req.query.customer === "string" ? req.query.customer : null;
    const whereClauses = [
      sql`(${schema.aiExtractSamplesTable.expiresAt} > now() OR ${schema.aiExtractSamplesTable.pinned} = true)`,
    ];
    if (customer) {
      whereClauses.push(eq(schema.aiExtractSamplesTable.customer, customer));
    }
    const rows = await db
      .select({
        id: schema.aiExtractSamplesTable.id,
        weekStart: schema.aiExtractSamplesTable.weekStart,
        customer: schema.aiExtractSamplesTable.customer,
        fileName: schema.aiExtractSamplesTable.fileName,
        mimeType: schema.aiExtractSamplesTable.mimeType,
        sizeBytes: schema.aiExtractSamplesTable.sizeBytes,
        uploadedBy: schema.aiExtractSamplesTable.uploadedBy,
        uploadedAt: schema.aiExtractSamplesTable.uploadedAt,
        confirmedAt: schema.aiExtractSamplesTable.confirmedAt,
        expiresAt: schema.aiExtractSamplesTable.expiresAt,
        pinned: schema.aiExtractSamplesTable.pinned,
      })
      .from(schema.aiExtractSamplesTable)
      .where(and(...whereClauses))
      .orderBy(desc(schema.aiExtractSamplesTable.uploadedAt))
      .limit(500);
    const actorIds = new Set<number>();
    for (const r of rows) if (r.uploadedBy) actorIds.add(r.uploadedBy);
    const actorEmailById = new Map<number, string>();
    if (actorIds.size > 0) {
      const actorRows = await db
        .select({ id: schema.usersTable.id, email: schema.usersTable.email })
        .from(schema.usersTable)
        .where(inArray(schema.usersTable.id, [...actorIds]));
      for (const r of actorRows) actorEmailById.set(r.id, r.email);
    }
    res.json(
      rows.map((r) => ({
        id: r.id,
        weekStart: r.weekStart,
        customer: r.customer,
        fileName: r.fileName,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        uploadedAt: new Date(r.uploadedAt).toISOString(),
        expiresAt: new Date(r.expiresAt).toISOString(),
        confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
        confirmed: r.confirmedAt != null,
        pinned: r.pinned,
        uploadedByEmail: r.uploadedBy
          ? actorEmailById.get(r.uploadedBy) ?? null
          : null,
      })),
    );
  },
);

weeksRouter.patch(
  "/admin/ai-extract-samples/:id/pin",
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const pinned = req.body?.pinned;
    if (typeof pinned !== "boolean") {
      res.status(400).json({ error: "pinned must be a boolean" });
      return;
    }
    const actorUserId = req.session.userId ?? null;
    const row = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.aiExtractSamplesTable)
        .set({ pinned })
        .where(eq(schema.aiExtractSamplesTable.id, id))
        .returning({
          id: schema.aiExtractSamplesTable.id,
          weekStart: schema.aiExtractSamplesTable.weekStart,
          customer: schema.aiExtractSamplesTable.customer,
          fileName: schema.aiExtractSamplesTable.fileName,
          mimeType: schema.aiExtractSamplesTable.mimeType,
          sizeBytes: schema.aiExtractSamplesTable.sizeBytes,
          uploadedBy: schema.aiExtractSamplesTable.uploadedBy,
          uploadedAt: schema.aiExtractSamplesTable.uploadedAt,
          confirmedAt: schema.aiExtractSamplesTable.confirmedAt,
          expiresAt: schema.aiExtractSamplesTable.expiresAt,
          pinned: schema.aiExtractSamplesTable.pinned,
        });
      const r = updated[0];
      if (!r) return null;
      await tx.insert(schema.userAuditLogTable).values({
        actorUserId,
        targetUserId: null,
        targetEmail: `ai-sample:${r.id}|${r.weekStart}|${r.customer}|${r.fileName}`,
        action: pinned ? "pin-ai-extract-sample" : "unpin-ai-extract-sample",
      });
      return r;
    });
    if (!row) {
      res.status(404).json({ error: "Sample not found" });
      return;
    }
    let uploadedByEmail: string | null = null;
    if (row.uploadedBy) {
      const actor = await db.query.usersTable.findFirst({
        where: eq(schema.usersTable.id, row.uploadedBy),
        columns: { email: true },
      });
      uploadedByEmail = actor?.email ?? null;
    }
    res.json({
      id: row.id,
      weekStart: row.weekStart,
      customer: row.customer,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      uploadedAt: new Date(row.uploadedAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
      confirmed: row.confirmedAt != null,
      pinned: row.pinned,
      uploadedByEmail,
    });
  },
);

weeksRouter.delete(
  "/admin/ai-extract-samples/:id",
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const actorUserId = req.session.userId ?? null;
    const deleted = await db.transaction(async (tx) => {
      const removed = await tx
        .delete(schema.aiExtractSamplesTable)
        .where(eq(schema.aiExtractSamplesTable.id, id))
        .returning({
          id: schema.aiExtractSamplesTable.id,
          customer: schema.aiExtractSamplesTable.customer,
          fileName: schema.aiExtractSamplesTable.fileName,
          weekStart: schema.aiExtractSamplesTable.weekStart,
        });
      const row = removed[0];
      if (!row) return null;
      await tx.insert(schema.userAuditLogTable).values({
        actorUserId,
        targetUserId: null,
        targetEmail: `ai-sample:${row.id}|${row.weekStart}|${row.customer}|${row.fileName}`,
        action: "delete-ai-extract-sample",
      });
      return row;
    });
    if (!deleted) {
      res.status(404).json({ error: "Sample not found" });
      return;
    }
    res.status(204).end();
  },
);

weeksRouter.get(
  "/admin/ai-extract-samples/:id/download",
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const row = await db.query.aiExtractSamplesTable.findFirst({
      where: and(
        eq(schema.aiExtractSamplesTable.id, id),
        sql`(${schema.aiExtractSamplesTable.expiresAt} > now() OR ${schema.aiExtractSamplesTable.pinned} = true)`,
      ),
    });
    if (!row) {
      res.status(404).json({ error: "Sample not found or expired" });
      return;
    }
    res.setHeader("Content-Type", row.mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${row.fileName.replace(/"/g, "")}"`,
    );
    res.send(row.fileBytes);
  },
);

weeksRouter.get("/customer-aliases", requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      customer: schema.customerNameAliasesTable.customer,
      nameOnDoc: schema.customerNameAliasesTable.nameOnDoc,
      kfiId: schema.customerNameAliasesTable.kfiId,
      updatedAt: schema.customerNameAliasesTable.updatedAt,
      updatedBy: schema.customerNameAliasesTable.updatedBy,
      driverName: schema.driversTable.name,
      driverCustomer: schema.driversTable.customer,
      driverIsArchived: schema.driversTable.isArchived,
    })
    .from(schema.customerNameAliasesTable)
    .leftJoin(
      schema.driversTable,
      eq(schema.customerNameAliasesTable.kfiId, schema.driversTable.kfiId),
    )
    .orderBy(
      asc(sql`lower(${schema.customerNameAliasesTable.customer})`),
      asc(sql`lower(${schema.customerNameAliasesTable.nameOnDoc})`),
    );
  const actorIds = new Set<number>();
  for (const r of rows) if (r.updatedBy) actorIds.add(r.updatedBy);
  const actorEmailById = new Map<number, string>();
  if (actorIds.size > 0) {
    const actorRows = await db
      .select({ id: schema.usersTable.id, email: schema.usersTable.email })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, [...actorIds]));
    for (const a of actorRows) actorEmailById.set(a.id, a.email);
  }
  const driverRows = await db
    .select({
      kfiId: schema.driversTable.kfiId,
      name: schema.driversTable.name,
      customer: schema.driversTable.customer,
      ctUserId: schema.driversTable.ctUserId,
      isDriver: schema.driversTable.isDriver,
    })
    .from(schema.driversTable)
    .where(eq(schema.driversTable.isArchived, false))
    .orderBy(asc(sql`lower(${schema.driversTable.name})`));
  const usageRows = await db
    .select({
      customerLower: sql<string>`lower(${schema.punchesTable.customer})`.as(
        "customer_lower",
      ),
      kfiId: schema.punchesTable.kfiId,
      lastWeek: sql<string>`max(${schema.punchesTable.weekStart})`.as(
        "last_week",
      ),
      weekCount: sql<number>`count(distinct ${schema.punchesTable.weekStart})::int`.as(
        "week_count",
      ),
    })
    .from(schema.punchesTable)
    .where(
      and(
        eq(schema.punchesTable.source, "Customer"),
        eq(schema.punchesTable.isManual, false),
        sql`${schema.punchesTable.customer} is not null`,
      ),
    )
    .groupBy(
      sql`lower(${schema.punchesTable.customer})`,
      schema.punchesTable.kfiId,
    );
  const usageMap = new Map<
    string,
    { lastUsedWeek: string | null; weeksUsedCount: number }
  >();
  for (const u of usageRows) {
    usageMap.set(`${u.customerLower}::${u.kfiId}`, {
      lastUsedWeek: u.lastWeek ?? null,
      weeksUsedCount: Number(u.weekCount ?? 0),
    });
  }
  res.json({
    aliases: rows.map((r) => {
      const usage = usageMap.get(`${r.customer.toLowerCase()}::${r.kfiId}`);
      return {
        customer: r.customer,
        nameOnDoc: r.nameOnDoc,
        kfiId: r.kfiId,
        driverName: r.driverName ?? null,
        driverCustomer: r.driverCustomer ?? null,
        driverIsArchived: r.driverIsArchived ?? null,
        updatedAt: new Date(r.updatedAt).toISOString(),
        updatedByEmail: r.updatedBy
          ? actorEmailById.get(r.updatedBy) ?? null
          : null,
        lastUsedWeek: usage?.lastUsedWeek ?? null,
        weeksUsedCount: usage?.weeksUsedCount ?? 0,
      };
    }),
    drivers: driverRows.map((d) => ({
      kfiId: d.kfiId,
      name: d.name,
      customer: d.customer,
      ctUserId: d.ctUserId ?? null,
      isDriver: d.isDriver,
    })),
  });
});

weeksRouter.patch("/customer-aliases", requireAdmin, async (req, res) => {
  const customer = String(req.query.customer ?? "").trim();
  const nameOnDoc = String(req.query.nameOnDoc ?? "").trim();
  if (!customer || !nameOnDoc) {
    res.status(400).json({ error: "customer and nameOnDoc are required" });
    return;
  }
  const parsed = UpdateCustomerNameAliasBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { kfiId } = parsed.data;
  const driver = await db.query.driversTable.findFirst({
    where: eq(schema.driversTable.kfiId, kfiId),
  });
  if (!driver) {
    res.status(400).json({ error: "Unknown kfiId" });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ kfiId: schema.customerNameAliasesTable.kfiId })
      .from(schema.customerNameAliasesTable)
      .where(
        and(
          sql`lower(${schema.customerNameAliasesTable.customer}) = lower(${customer})`,
          sql`lower(${schema.customerNameAliasesTable.nameOnDoc}) = lower(${nameOnDoc})`,
        ),
      );
    if (!existing) return null;
    const [row] = await tx
      .update(schema.customerNameAliasesTable)
      .set({ kfiId, updatedBy: req.session.userId ?? null })
      .where(
        and(
          sql`lower(${schema.customerNameAliasesTable.customer}) = lower(${customer})`,
          sql`lower(${schema.customerNameAliasesTable.nameOnDoc}) = lower(${nameOnDoc})`,
        ),
      )
      .returning({
        customer: schema.customerNameAliasesTable.customer,
        nameOnDoc: schema.customerNameAliasesTable.nameOnDoc,
        kfiId: schema.customerNameAliasesTable.kfiId,
        updatedAt: schema.customerNameAliasesTable.updatedAt,
        updatedBy: schema.customerNameAliasesTable.updatedBy,
      });
    if (!row) return null;
    if (existing.kfiId !== row.kfiId) {
      await tx.insert(schema.customerAliasAuditLogTable).values({
        actorUserId: req.session.userId ?? null,
        customer: row.customer,
        nameOnDoc: row.nameOnDoc,
        action: "remap",
        beforeKfiId: existing.kfiId,
        afterKfiId: row.kfiId,
      });
    }
    return row;
  });
  if (!updated) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }
  let updatedByEmail: string | null = null;
  if (updated.updatedBy) {
    const actor = await db.query.usersTable.findFirst({
      where: eq(schema.usersTable.id, updated.updatedBy),
      columns: { email: true },
    });
    updatedByEmail = actor?.email ?? null;
  }
  const [usage] = await db
    .select({
      lastWeek: sql<string>`max(${schema.punchesTable.weekStart})`,
      weekCount: sql<number>`count(distinct ${schema.punchesTable.weekStart})::int`,
    })
    .from(schema.punchesTable)
    .where(
      and(
        eq(schema.punchesTable.source, "Customer"),
        eq(schema.punchesTable.isManual, false),
        eq(schema.punchesTable.kfiId, updated.kfiId),
        sql`lower(${schema.punchesTable.customer}) = lower(${updated.customer})`,
      ),
    );
  res.json({
    customer: updated.customer,
    nameOnDoc: updated.nameOnDoc,
    kfiId: updated.kfiId,
    driverName: driver.name,
    driverCustomer: driver.customer,
    driverIsArchived: driver.isArchived,
    updatedAt: new Date(updated.updatedAt).toISOString(),
    updatedByEmail,
    lastUsedWeek: usage?.lastWeek ?? null,
    weeksUsedCount: Number(usage?.weekCount ?? 0),
  });
});

weeksRouter.delete("/customer-aliases", async (req, res) => {
  const customer = String(req.query.customer ?? "").trim();
  const nameOnDoc = String(req.query.nameOnDoc ?? "").trim();
  if (!customer || !nameOnDoc) {
    res.status(400).json({ error: "customer and nameOnDoc are required" });
    return;
  }
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(schema.customerNameAliasesTable)
      .where(
        and(
          sql`lower(${schema.customerNameAliasesTable.customer}) = lower(${customer})`,
          sql`lower(${schema.customerNameAliasesTable.nameOnDoc}) = lower(${nameOnDoc})`,
        ),
      )
      .returning({
        customer: schema.customerNameAliasesTable.customer,
        nameOnDoc: schema.customerNameAliasesTable.nameOnDoc,
        kfiId: schema.customerNameAliasesTable.kfiId,
      });
    if (deleted) {
      await tx.insert(schema.customerAliasAuditLogTable).values({
        actorUserId: req.session.userId ?? null,
        customer: deleted.customer,
        nameOnDoc: deleted.nameOnDoc,
        action: "forget",
        beforeKfiId: deleted.kfiId,
        afterKfiId: null,
      });
    }
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Driver-id aliases (admin-managed extension of EMBEDDED_MAPPING).
// Maps a customer payroll id (badge #, TELD code, employee number, etc.) to
// an existing KFI driver. Loaded on every customer-file upload and merged
// with EMBEDDED_MAPPING at parse time (DB rows win).
// ---------------------------------------------------------------------------

async function serializeDriverIdAliases(
  rows: Array<{
    externalId: string;
    kfiId: string;
    customer: string | null;
    sampleName: string | null;
    note: string | null;
    createdAt: Date;
    updatedAt: Date;
    createdBy: number | null;
    updatedBy: number | null;
    driverName: string | null;
    driverCustomer: string | null;
    driverIsArchived: boolean | null;
  }>,
) {
  const actorIds = new Set<number>();
  for (const r of rows) {
    if (r.createdBy) actorIds.add(r.createdBy);
    if (r.updatedBy) actorIds.add(r.updatedBy);
  }
  const actorEmailById = new Map<number, string>();
  if (actorIds.size > 0) {
    const actorRows = await db
      .select({ id: schema.usersTable.id, email: schema.usersTable.email })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, [...actorIds]));
    for (const a of actorRows) actorEmailById.set(a.id, a.email);
  }
  return rows.map((r) => ({
    externalId: r.externalId,
    kfiId: r.kfiId,
    customer: r.customer,
    sampleName: r.sampleName,
    note: r.note,
    driverName: r.driverName,
    driverCustomer: r.driverCustomer,
    driverIsArchived: r.driverIsArchived,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    createdByEmail: r.createdBy ? actorEmailById.get(r.createdBy) ?? null : null,
    updatedByEmail: r.updatedBy ? actorEmailById.get(r.updatedBy) ?? null : null,
  }));
}

const aliasSelect = {
  externalId: schema.driverIdAliasesTable.externalId,
  kfiId: schema.driverIdAliasesTable.kfiId,
  customer: schema.driverIdAliasesTable.customer,
  sampleName: schema.driverIdAliasesTable.sampleName,
  note: schema.driverIdAliasesTable.note,
  createdAt: schema.driverIdAliasesTable.createdAt,
  updatedAt: schema.driverIdAliasesTable.updatedAt,
  createdBy: schema.driverIdAliasesTable.createdBy,
  updatedBy: schema.driverIdAliasesTable.updatedBy,
  driverName: schema.driversTable.name,
  driverCustomer: schema.driversTable.customer,
  driverIsArchived: schema.driversTable.isArchived,
};

weeksRouter.get("/driver-id-aliases", requireAdmin, async (_req, res) => {
  const rows = await db
    .select(aliasSelect)
    .from(schema.driverIdAliasesTable)
    .leftJoin(
      schema.driversTable,
      eq(schema.driverIdAliasesTable.kfiId, schema.driversTable.kfiId),
    )
    .orderBy(asc(sql`lower(${schema.driverIdAliasesTable.externalId})`));
  const aliases = await serializeDriverIdAliases(rows);
  const driverRows = await db
    .select({
      kfiId: schema.driversTable.kfiId,
      name: schema.driversTable.name,
      customer: schema.driversTable.customer,
      ctUserId: schema.driversTable.ctUserId,
      isDriver: schema.driversTable.isDriver,
    })
    .from(schema.driversTable)
    .where(eq(schema.driversTable.isArchived, false))
    .orderBy(asc(sql`lower(${schema.driversTable.name})`));
  res.json({
    aliases,
    drivers: driverRows.map((d) => ({
      kfiId: d.kfiId,
      name: d.name,
      customer: d.customer,
      ctUserId: d.ctUserId ?? null,
      isDriver: d.isDriver,
    })),
  });
});

async function fetchAliasJoined(externalId: string) {
  const [row] = await db
    .select(aliasSelect)
    .from(schema.driverIdAliasesTable)
    .leftJoin(
      schema.driversTable,
      eq(schema.driverIdAliasesTable.kfiId, schema.driversTable.kfiId),
    )
    .where(
      sql`lower(${schema.driverIdAliasesTable.externalId}) = lower(${externalId})`,
    );
  return row;
}

weeksRouter.post("/driver-id-aliases", requireAdmin, async (req, res) => {
  const parsed = CreateDriverIdAliasBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { externalId, kfiId, customer, sampleName, note } = parsed.data;
  const driver = await db.query.driversTable.findFirst({
    where: eq(schema.driversTable.kfiId, kfiId),
  });
  if (!driver) {
    res.status(400).json({ error: "Unknown kfiId" });
    return;
  }
  const userId = req.session.userId ?? null;
  await db
    .insert(schema.driverIdAliasesTable)
    .values({
      externalId,
      kfiId,
      customer: customer ?? null,
      sampleName: sampleName ?? null,
      note: note ?? null,
      createdBy: userId,
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: schema.driverIdAliasesTable.externalId,
      set: {
        kfiId,
        customer: customer ?? null,
        sampleName: sampleName ?? null,
        note: note ?? null,
        updatedBy: userId,
      },
    });
  const row = await fetchAliasJoined(externalId);
  if (!row) {
    res.status(500).json({ error: "Insert succeeded but row not found" });
    return;
  }
  const [serialized] = await serializeDriverIdAliases([row]);
  res.json(serialized);
});

weeksRouter.patch(
  "/driver-id-aliases/:externalId",
  requireAdmin,
  async (req, res) => {
    const externalId = String(req.params.externalId ?? "").trim();
    if (!externalId) {
      res.status(400).json({ error: "externalId is required" });
      return;
    }
    const parsed = UpdateDriverIdAliasBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }
    const updates: Record<string, unknown> = {
      updatedBy: req.session.userId ?? null,
    };
    if (parsed.data.kfiId !== undefined) {
      const driver = await db.query.driversTable.findFirst({
        where: eq(schema.driversTable.kfiId, parsed.data.kfiId),
      });
      if (!driver) {
        res.status(400).json({ error: "Unknown kfiId" });
        return;
      }
      updates.kfiId = parsed.data.kfiId;
    }
    if (parsed.data.customer !== undefined) updates.customer = parsed.data.customer;
    if (parsed.data.sampleName !== undefined) updates.sampleName = parsed.data.sampleName;
    if (parsed.data.note !== undefined) updates.note = parsed.data.note;
    const [updated] = await db
      .update(schema.driverIdAliasesTable)
      .set(updates)
      .where(
        sql`lower(${schema.driverIdAliasesTable.externalId}) = lower(${externalId})`,
      )
      .returning({ externalId: schema.driverIdAliasesTable.externalId });
    if (!updated) {
      res.status(404).json({ error: "Alias not found" });
      return;
    }
    const row = await fetchAliasJoined(updated.externalId);
    if (!row) {
      res.status(404).json({ error: "Alias not found" });
      return;
    }
    const [serialized] = await serializeDriverIdAliases([row]);
    res.json(serialized);
  },
);

weeksRouter.delete(
  "/driver-id-aliases/:externalId",
  requireAdmin,
  async (req, res) => {
    const externalId = String(req.params.externalId ?? "").trim();
    if (!externalId) {
      res.status(400).json({ error: "externalId is required" });
      return;
    }
    await db
      .delete(schema.driverIdAliasesTable)
      .where(
        sql`lower(${schema.driverIdAliasesTable.externalId}) = lower(${externalId})`,
      );
    res.status(204).end();
  },
);

weeksRouter.get(
  "/customer-aliases/audit-log",
  requireAdmin,
  async (req, res) => {
    const limitParam = Number(req.query.limit);
    const limit =
      Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500
        ? limitParam
        : 100;
    const customerFilter =
      typeof req.query.customer === "string" && req.query.customer.trim()
        ? req.query.customer.trim()
        : null;
    const nameOnDocFilter =
      typeof req.query.nameOnDoc === "string" && req.query.nameOnDoc.trim()
        ? req.query.nameOnDoc.trim()
        : null;

    const conds: SQL[] = [];
    if (customerFilter) {
      conds.push(
        sql`lower(${schema.customerAliasAuditLogTable.customer}) = lower(${customerFilter})`,
      );
    }
    if (nameOnDocFilter) {
      conds.push(
        sql`lower(${schema.customerAliasAuditLogTable.nameOnDoc}) = lower(${nameOnDocFilter})`,
      );
    }

    const baseQuery = db
      .select({
        id: schema.customerAliasAuditLogTable.id,
        action: schema.customerAliasAuditLogTable.action,
        customer: schema.customerAliasAuditLogTable.customer,
        nameOnDoc: schema.customerAliasAuditLogTable.nameOnDoc,
        beforeKfiId: schema.customerAliasAuditLogTable.beforeKfiId,
        afterKfiId: schema.customerAliasAuditLogTable.afterKfiId,
        createdAt: schema.customerAliasAuditLogTable.createdAt,
        actorUserId: schema.customerAliasAuditLogTable.actorUserId,
        actorEmail: schema.usersTable.email,
      })
      .from(schema.customerAliasAuditLogTable)
      .leftJoin(
        schema.usersTable,
        eq(
          schema.usersTable.id,
          schema.customerAliasAuditLogTable.actorUserId,
        ),
      );
    const filtered =
      conds.length > 0 ? baseQuery.where(and(...conds)) : baseQuery;
    const rows = await filtered
      .orderBy(desc(schema.customerAliasAuditLogTable.createdAt))
      .limit(limit);

    const beforeIds = new Set<string>();
    const afterIds = new Set<string>();
    for (const r of rows) {
      if (r.beforeKfiId) beforeIds.add(r.beforeKfiId);
      if (r.afterKfiId) afterIds.add(r.afterKfiId);
    }
    const allIds = [...new Set([...beforeIds, ...afterIds])];
    const driverNameById = new Map<string, string>();
    if (allIds.length > 0) {
      const driverRows = await db
        .select({
          kfiId: schema.driversTable.kfiId,
          name: schema.driversTable.name,
        })
        .from(schema.driversTable)
        .where(inArray(schema.driversTable.kfiId, allIds));
      for (const d of driverRows) driverNameById.set(d.kfiId, d.name);
    }

    res.json(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        customer: r.customer,
        nameOnDoc: r.nameOnDoc,
        beforeKfiId: r.beforeKfiId,
        afterKfiId: r.afterKfiId,
        beforeDriverName: r.beforeKfiId
          ? driverNameById.get(r.beforeKfiId) ?? null
          : null,
        afterDriverName: r.afterKfiId
          ? driverNameById.get(r.afterKfiId) ?? null
          : null,
        actorUserId: r.actorUserId,
        actorEmail: r.actorEmail ?? null,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
    );
  },
);

weeksRouter.post("/weeks/:weekStart/manual-punches", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const parsed = CreateManualPunchBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { startDate, endDate } = await ensureWeek(weekStart);
  if (parsed.data.date < startDate || parsed.data.date > endDate) {
    res.status(400).json({ error: "Date is outside the week" });
    return;
  }
  if (!(await assertNotLocked(res, startDate, parsed.data.kfiId))) return;
  const driverDisplayTz = await loadDriverTz(parsed.data.kfiId);
  const dispTz = resolveDispTz(
    parsed.data.kfiId,
    driverDisplayTz,
    parsed.data.dispTz ?? null,
  );
  // Always store clock-in/out as a fully-prefixed wall-clock string
  // ("YYYY-MM-DD H:MM AM"), and compute hours via the same `localStrToSortMs`
  // parser the hours engine uses. Using `new Date()` here previously made
  // the duration math depend on the *server*'s local tz, which on a server
  // observing DST could shift the implied offset for times near a DST
  // transition (or, for inputs the JS Date parser couldn't read, silently
  // produce 0 hours). Going through `diffHours` keeps every step of the
  // pipeline (storage, sort, engine) on the same tz-agnostic parser, so a
  // punch the dispatcher entered as Wednesday 7:30am – 5:30pm always lands
  // on Wednesday with 10.0h regardless of the box this code runs on.
  const clockIn = `${parsed.data.date} ${parsed.data.clockIn}`;
  const clockOut = `${parsed.data.date} ${parsed.data.clockOut}`;
  const hours = Math.round(diffHours(clockIn, clockOut) * 100) / 100;
  const [row] = await db
    .insert(schema.punchesTable)
    .values({
      weekStart: startDate,
      kfiId: parsed.data.kfiId,
      customer: parsed.data.customer ?? null,
      source: parsed.data.source,
      date: parsed.data.date,
      clockIn,
      clockOut,
      hours: String(hours),
      payType: parsed.data.payType ?? null,
      dispTz,
      isManual: true,
      createdBy: req.session.userId ?? null,
    })
    .returning();
  publishRealtime({
    type: "punch-changed",
    weekStart: startDate,
    kfiId: parsed.data.kfiId,
    action: "create",
    punchId: row.id,
    actor: actorRef(req),
  });
  res.json(serializePunch(row));
});

// Helpers shared by scale-hours / reset-hours. Round to 2dp and load every
// punch (any source, manual or imported) for a single (week, driver, date).
const r2 = (n: number): number => Math.round(n * 100) / 100;

async function loadDayPunches(
  weekStart: string,
  kfiId: string,
  date: string,
) {
  return db
    .select()
    .from(schema.punchesTable)
    .where(
      and(
        eq(schema.punchesTable.weekStart, weekStart),
        eq(schema.punchesTable.kfiId, kfiId),
        eq(schema.punchesTable.date, date),
      ),
    )
    .orderBy(asc(schema.punchesTable.clockIn));
}

/**
 * Set a day's total by proportionally scaling each contributing punch's
 * `hours` field. Lets the dispatcher fix a sub-percent typo against the
 * Connecteam-side total (e.g. 8.47 → 8.50) without having to find which
 * underlying punch is off by a minute. Clock-in / out are untouched so the
 * audit trail and customer-file source rows stay intact; each scaled punch
 * is stamped `edited=true` + `updatedBy` so attribution works.
 *
 * Rounding: per-punch scaled hours are rounded to 2dp, then any residue
 * (±0.01) is folded into the *largest* punch so the day sum lands exactly
 * on the requested total. Going through the largest punch keeps the
 * relative weights stable across scale + reset cycles.
 */
weeksRouter.post(
  "/weeks/:weekStart/drivers/:kfiId/days/:date/scale-hours",
  async (req, res) => {
    const weekStart = req.params.weekStart;
    const kfiId = req.params.kfiId;
    const date = req.params.date;
    if (!isWeek(weekStart) || !WEEK_RE.test(date)) {
      res.status(400).json({ error: "Invalid week or date" });
      return;
    }
    const body = req.body as { totalHours?: unknown };
    const target =
      typeof body.totalHours === "number" && Number.isFinite(body.totalHours)
        ? body.totalHours
        : NaN;
    if (!Number.isFinite(target) || target < 0 || target > 24) {
      res.status(400).json({ error: "totalHours must be between 0 and 24" });
      return;
    }
    const { startDate, endDate } = await ensureWeek(weekStart);
    if (date < startDate || date > endDate) {
      res.status(400).json({ error: "Date is outside the week" });
      return;
    }
    if (!(await assertNotLocked(res, startDate, kfiId))) return;
    const punches = await loadDayPunches(startDate, kfiId, date);
    if (punches.length === 0) {
      res.status(400).json({ error: "No punches on this day to scale" });
      return;
    }
    const current = punches.reduce((sum, p) => sum + Number(p.hours), 0);
    if (current <= 0.0001) {
      res.status(400).json({
        error:
          "Day total is zero — fix at least one clock-in/out before scaling.",
      });
      return;
    }
    const targetR2 = r2(target);
    const ratio = targetR2 / current;
    const scaled = punches.map((p) => r2(Number(p.hours) * ratio));
    // Fold any rounding residue into the row with the largest absolute
    // contribution so the day sum is exactly targetR2.
    const sum = scaled.reduce((a, b) => a + b, 0);
    const residue = r2(targetR2 - sum);
    if (Math.abs(residue) >= 0.005) {
      let maxIdx = 0;
      for (let i = 1; i < scaled.length; i++) {
        if (scaled[i] > scaled[maxIdx]) maxIdx = i;
      }
      scaled[maxIdx] = r2(scaled[maxIdx] + residue);
    }

    const updated = await db.transaction(async (tx) => {
      const out: typeof punches = [];
      for (let i = 0; i < punches.length; i++) {
        const [row] = await tx
          .update(schema.punchesTable)
          .set({
            hours: String(scaled[i]),
            edited: true,
            updatedBy: req.session.userId ?? null,
          })
          .where(eq(schema.punchesTable.id, punches[i].id))
          .returning();
        out.push(row);
      }
      return out;
    });

    publishRealtime({
      type: "punch-changed",
      weekStart: startDate,
      kfiId,
      action: "update",
      punchId: updated[0]?.id ?? 0,
      actor: actorRef(req),
    });
    res.json({
      date,
      totalHours: targetR2,
      punches: updated.map((p) => serializePunch(p)),
    });
  },
);

/**
 * Revert a previous scale on this day by recomputing each punch's `hours`
 * from `diffHours(clockIn, clockOut)`. Clock times and the `edited` flag
 * (which tracks clock-edits, not hours-edits) are left untouched so a
 * dispatcher's prior in/out corrections survive the reset.
 */
weeksRouter.post(
  "/weeks/:weekStart/drivers/:kfiId/days/:date/reset-hours",
  async (req, res) => {
    const weekStart = req.params.weekStart;
    const kfiId = req.params.kfiId;
    const date = req.params.date;
    if (!isWeek(weekStart) || !WEEK_RE.test(date)) {
      res.status(400).json({ error: "Invalid week or date" });
      return;
    }
    const { startDate, endDate } = await ensureWeek(weekStart);
    if (date < startDate || date > endDate) {
      res.status(400).json({ error: "Date is outside the week" });
      return;
    }
    if (!(await assertNotLocked(res, startDate, kfiId))) return;
    const punches = await loadDayPunches(startDate, kfiId, date);
    if (punches.length === 0) {
      res.status(400).json({ error: "No punches on this day to reset" });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      const out: typeof punches = [];
      for (const p of punches) {
        const natural = r2(diffHours(p.clockIn, p.clockOut));
        const [row] = await tx
          .update(schema.punchesTable)
          .set({
            hours: String(natural),
            updatedBy: req.session.userId ?? null,
          })
          .where(eq(schema.punchesTable.id, p.id))
          .returning();
        out.push(row);
      }
      return out;
    });

    const total = r2(updated.reduce((sum, p) => sum + Number(p.hours), 0));
    publishRealtime({
      type: "punch-changed",
      weekStart: startDate,
      kfiId,
      action: "update",
      punchId: updated[0]?.id ?? 0,
      actor: actorRef(req),
    });
    res.json({
      date,
      totalHours: total,
      punches: updated.map((p) => serializePunch(p)),
    });
  },
);

/**
 * Compute a "what-if" preview of a draft (or edited) punch without writing
 * anything. Powers the live preview block in the Add-Manual-Punch dialog
 * and the inline-edit recompute. Mirrors the same hours engine the server
 * uses on `/weeks/:weekStart/drivers/:kfiId`, so the preview matches what
 * the dispatcher will see post-save to the decimal.
 */
weeksRouter.post("/weeks/:weekStart/preview-punch", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const body = req.body as {
    kfiId?: unknown;
    source?: unknown;
    customer?: unknown;
    date?: unknown;
    clockIn?: unknown;
    clockOut?: unknown;
    excludePunchId?: unknown;
    dispTz?: unknown;
  };
  const kfiId = typeof body.kfiId === "string" ? body.kfiId : "";
  const source =
    body.source === "Driver" || body.source === "Customer"
      ? body.source
      : null;
  const date = typeof body.date === "string" ? body.date : "";
  const rawIn = typeof body.clockIn === "string" ? body.clockIn.trim() : "";
  const rawOut = typeof body.clockOut === "string" ? body.clockOut.trim() : "";
  const excludePunchId =
    typeof body.excludePunchId === "number" && Number.isFinite(body.excludePunchId)
      ? body.excludePunchId
      : null;
  if (
    !kfiId ||
    !source ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { startDate, endDate } = await ensureWeek(weekStart);

  // Strip any leading date if the dispatcher pasted a fully-qualified
  // wall-clock string; we always re-anchor against the form's date so the
  // preview matches what we'd actually persist.
  const stripDate = (s: string): string =>
    s.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").trim();
  const normalizedClockIn = rawIn ? `${date} ${stripDate(rawIn)}` : "";
  const normalizedClockOut = rawOut ? `${date} ${stripDate(rawOut)}` : "";

  const inMs = localStrToSortMs(normalizedClockIn);
  const outMs = localStrToSortMs(normalizedClockOut);
  let valid = false;
  let invalidReason: string | null = null;
  let hours = 0;
  if (!normalizedClockIn || inMs === null) {
    invalidReason = "Clock-in is missing or unparseable";
  } else if (!normalizedClockOut || outMs === null) {
    invalidReason = "Clock-out is missing or unparseable";
  } else if (outMs <= inMs) {
    invalidReason = "Clock-out must be after clock-in";
  } else {
    valid = true;
    hours = Math.round(((outMs - inMs) / 3_600_000) * 1000) / 1000;
  }
  if (date < startDate || date > endDate) {
    valid = false;
    invalidReason = "Date is outside the week";
  }

  // Pull the existing punches so we can splice the draft in.
  const existing = await db
    .select()
    .from(schema.punchesTable)
    .where(
      and(
        eq(schema.punchesTable.weekStart, startDate),
        eq(schema.punchesTable.kfiId, kfiId),
      ),
    );

  const driverDisplayTz = await loadDriverTz(kfiId);
  const dispTz = resolveDispTz(
    kfiId,
    driverDisplayTz,
    typeof body.dispTz === "string" ? body.dispTz : null,
  );

  const filtered = excludePunchId
    ? existing.filter((p) => p.id !== excludePunchId)
    : existing;

  // Build a synthetic Punch for the preview. Only fields the engine reads
  // need to be accurate — id is a placeholder that will never collide with
  // a real row.
  const draft = {
    id: -1,
    weekStart: startDate,
    kfiId,
    customer:
      typeof body.customer === "string" && body.customer ? body.customer : null,
    source,
    date,
    clockIn: normalizedClockIn,
    clockOut: normalizedClockOut,
    hours: String(hours),
    payType: null,
    dispTz,
    isManual: true,
    edited: false,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ctExternalKey: null,
    fileOrigin: null,
  } as unknown as typeof schema.punchesTable.$inferSelect;

  const projected = valid ? [...filtered, draft] : filtered;
  const totals = computeDriverTotals(projected);
  const daily = computeDailyTotals(projected, startDate, endDate);
  const day = daily.find((d) => d.date === date) ?? {
    date,
    driverHours: 0,
    customerHours: 0,
    totalHours: 0,
    regularHours: 0,
    overtimeHours: 0,
  };

  // Find same-source existing punches that overlap the preview window by
  // more than 10 minutes (the same threshold `computeChecks` uses).
  const overlaps: Array<{
    id: number;
    source: "Driver" | "Customer";
    date: string;
    clockIn: string;
    clockOut: string;
    overlapMinutes: number;
  }> = [];
  if (valid && inMs !== null && outMs !== null) {
    for (const p of filtered) {
      if (p.source !== source) continue;
      const pi = localStrToSortMs(p.clockIn);
      const po = localStrToSortMs(p.clockOut);
      if (pi === null || po === null) continue;
      const overlapMs = Math.min(outMs, po) - Math.max(inMs, pi);
      if (overlapMs > 10 * 60 * 1000) {
        overlaps.push({
          id: p.id,
          source: p.source as "Driver" | "Customer",
          date: p.date,
          clockIn: p.clockIn,
          clockOut: p.clockOut,
          overlapMinutes: Math.round(overlapMs / 60000),
        });
      }
    }
  }

  res.json({
    valid,
    invalidReason,
    normalizedClockIn,
    normalizedClockOut,
    hours,
    dailyTotalAfter: {
      date,
      driverHours: day.driverHours,
      customerHours: day.customerHours,
      totalHours: day.totalHours,
    },
    weekly: {
      driverHours: totals.totalDriver,
      customerHours: totals.totalCustomer,
      totalHours: totals.totalHours,
      regularHours: totals.regularHours,
      overtimeHours: totals.overtimeHours,
      driverRt: totals.driverRt,
      driverOt: totals.driverOt,
      custRt: totals.custRt,
      custOt: totals.custOt,
    },
    overlaps,
  });
});

weeksRouter.put("/weeks/:weekStart/reviewed/:kfiId", async (req, res) => {
  const weekStart = req.params.weekStart;
  const kfiId = req.params.kfiId;
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  const parsed = SetReviewedBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  // Tri-state: 'good' | 'bad' | null. Accept either:
  //   - new shape: { status: 'good'|'bad'|null }
  //   - legacy shape: { reviewed: boolean }  (true → 'good', false → null)
  let status: "good" | "bad" | null;
  if (parsed.data.status === "good" || parsed.data.status === "bad") {
    status = parsed.data.status;
  } else if (parsed.data.status === null) {
    status = null;
  } else if (typeof parsed.data.reviewed === "boolean") {
    status = parsed.data.reviewed ? "good" : null;
  } else {
    res.status(400).json({ error: "Provide status: 'good'|'bad'|null" });
    return;
  }
  const userId = req.session.userId ?? null;
  await db.transaction(async (tx) => {
    const existing = await tx.query.reviewedDriversTable.findFirst({
      where: and(
        eq(schema.reviewedDriversTable.weekStart, weekStart),
        eq(schema.reviewedDriversTable.kfiId, kfiId),
      ),
    });
    if (status === null) {
      // Clearing review. If the row is still locked, keep it but null out
      // the review fields. Otherwise delete the row entirely.
      if (existing?.lockedAt) {
        await tx
          .update(schema.reviewedDriversTable)
          .set({ status: null, reviewedBy: userId, reviewedAt: new Date() })
          .where(
            and(
              eq(schema.reviewedDriversTable.weekStart, weekStart),
              eq(schema.reviewedDriversTable.kfiId, kfiId),
            ),
          );
      } else if (existing) {
        await tx
          .delete(schema.reviewedDriversTable)
          .where(
            and(
              eq(schema.reviewedDriversTable.weekStart, weekStart),
              eq(schema.reviewedDriversTable.kfiId, kfiId),
            ),
          );
      }
    } else {
      await tx
        .insert(schema.reviewedDriversTable)
        .values({
          weekStart,
          kfiId,
          status,
          reviewedBy: userId,
        })
        .onConflictDoUpdate({
          target: [
            schema.reviewedDriversTable.weekStart,
            schema.reviewedDriversTable.kfiId,
          ],
          set: { status, reviewedBy: userId, reviewedAt: new Date() },
        });
    }
    await tx.insert(schema.driverWeekAuditLogTable).values({
      weekStart,
      kfiId,
      actorUserId: userId,
      action:
        status === "good"
          ? "review-good"
          : status === "bad"
            ? "review-bad"
            : "review-clear",
    });
  });
  publishRealtime({
    type: "review-changed",
    weekStart,
    kfiId,
    status,
    actor: actorRef(req),
  });
  res.json({ reviewed: status !== null, status });
});

// ---------------------------------------------------------------------------
// Lock / unlock a driver-week (supervisor or admin only) and audit trail.
// ---------------------------------------------------------------------------

async function readLockState(weekStart: string, kfiId: string) {
  const row = await db
    .select({
      lockedAt: schema.reviewedDriversTable.lockedAt,
      lockedByUserId: schema.reviewedDriversTable.lockedByUserId,
      email: schema.usersTable.email,
    })
    .from(schema.reviewedDriversTable)
    .leftJoin(
      schema.usersTable,
      eq(schema.usersTable.id, schema.reviewedDriversTable.lockedByUserId),
    )
    .where(
      and(
        eq(schema.reviewedDriversTable.weekStart, weekStart),
        eq(schema.reviewedDriversTable.kfiId, kfiId),
      ),
    )
    .limit(1);
  const r = row[0];
  return {
    locked: !!r?.lockedAt,
    lockedAt: r?.lockedAt ? new Date(r.lockedAt).toISOString() : null,
    lockedByEmail: r?.lockedAt ? r.email ?? null : null,
  };
}

weeksRouter.post(
  "/weeks/:weekStart/drivers/:kfiId/lock",
  requireSupervisorOrAdmin,
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    const kfiId = String(req.params.kfiId ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    const userId = req.session.userId ?? null;
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.reviewedDriversTable)
        .values({
          weekStart,
          kfiId,
          status: null,
          lockedAt: now,
          lockedByUserId: userId,
        })
        .onConflictDoUpdate({
          target: [
            schema.reviewedDriversTable.weekStart,
            schema.reviewedDriversTable.kfiId,
          ],
          set: { lockedAt: now, lockedByUserId: userId },
        });
      await tx.insert(schema.driverWeekAuditLogTable).values({
        weekStart,
        kfiId,
        actorUserId: userId,
        action: "lock",
      });
    });
    const state = await readLockState(weekStart, kfiId);
    publishRealtime({
      type: "lock-changed",
      weekStart,
      kfiId,
      locked: state.locked,
      lockedByEmail: state.lockedByEmail,
      actor: actorRef(req),
    });
    res.json(state);
  },
);

weeksRouter.delete(
  "/weeks/:weekStart/drivers/:kfiId/lock",
  requireSupervisorOrAdmin,
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    const kfiId = String(req.params.kfiId ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    const userId = req.session.userId ?? null;
    await db.transaction(async (tx) => {
      const existing = await tx.query.reviewedDriversTable.findFirst({
        where: and(
          eq(schema.reviewedDriversTable.weekStart, weekStart),
          eq(schema.reviewedDriversTable.kfiId, kfiId),
        ),
      });
      if (!existing) return;
      // If review status is also null, drop the row entirely. Otherwise
      // keep the row and just clear the lock columns.
      if (existing.status === null) {
        await tx
          .delete(schema.reviewedDriversTable)
          .where(
            and(
              eq(schema.reviewedDriversTable.weekStart, weekStart),
              eq(schema.reviewedDriversTable.kfiId, kfiId),
            ),
          );
      } else {
        await tx
          .update(schema.reviewedDriversTable)
          .set({ lockedAt: null, lockedByUserId: null })
          .where(
            and(
              eq(schema.reviewedDriversTable.weekStart, weekStart),
              eq(schema.reviewedDriversTable.kfiId, kfiId),
            ),
          );
      }
      await tx.insert(schema.driverWeekAuditLogTable).values({
        weekStart,
        kfiId,
        actorUserId: userId,
        action: "unlock",
      });
    });
    const state = await readLockState(weekStart, kfiId);
    publishRealtime({
      type: "lock-changed",
      weekStart,
      kfiId,
      locked: state.locked,
      lockedByEmail: state.lockedByEmail,
      actor: actorRef(req),
    });
    res.json(state);
  },
);

weeksRouter.get(
  "/weeks/:weekStart/drivers/:kfiId/audit",
  async (req, res) => {
    const weekStart = req.params.weekStart;
    const kfiId = req.params.kfiId;
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    const rows = await db
      .select({
        id: schema.driverWeekAuditLogTable.id,
        action: schema.driverWeekAuditLogTable.action,
        createdAt: schema.driverWeekAuditLogTable.createdAt,
        actorUserId: schema.driverWeekAuditLogTable.actorUserId,
        actorEmail: schema.usersTable.email,
      })
      .from(schema.driverWeekAuditLogTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.usersTable.id, schema.driverWeekAuditLogTable.actorUserId),
      )
      .where(
        and(
          eq(schema.driverWeekAuditLogTable.weekStart, weekStart),
          eq(schema.driverWeekAuditLogTable.kfiId, kfiId),
        ),
      )
      .orderBy(desc(schema.driverWeekAuditLogTable.createdAt))
      .limit(50);
    res.json(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        createdAt: new Date(r.createdAt).toISOString(),
        actorUserId: r.actorUserId,
        actorEmail: r.actorEmail ?? null,
      })),
    );
  },
);

// ---------------------------------------------------------------------------
// Driver-week notes (per-row + per-week, append-only, admin soft-delete)
// ---------------------------------------------------------------------------

async function loadNotesForDriverWeek(weekStart: string, kfiId: string) {
  // Self-alias usersTable so we can join the author and the last-hide-actor
  // independently in one round-trip. last_hidden_{at,by_user_id} is set on
  // every soft-delete and intentionally not cleared on restore, so the
  // driver-detail panel can render a "previously hidden by …" tag on
  // restored notes (admin viewers only).
  const hiderUsers = alias(schema.usersTable, "hider_users");
  const rows = await db
    .select({
      id: schema.driverNotesTable.id,
      weekStart: schema.driverNotesTable.weekStart,
      kfiId: schema.driverNotesTable.kfiId,
      punchId: schema.driverNotesTable.punchId,
      body: schema.driverNotesTable.body,
      authorUserId: schema.driverNotesTable.authorUserId,
      authorEmail: schema.usersTable.email,
      authorRole: schema.driverNotesTable.authorRole,
      createdAt: schema.driverNotesTable.createdAt,
      lastHiddenAt: schema.driverNotesTable.lastHiddenAt,
      lastHiddenByUserId: schema.driverNotesTable.lastHiddenByUserId,
      lastHiddenByEmail: hiderUsers.email,
    })
    .from(schema.driverNotesTable)
    .leftJoin(
      schema.usersTable,
      eq(schema.usersTable.id, schema.driverNotesTable.authorUserId),
    )
    .leftJoin(
      hiderUsers,
      eq(hiderUsers.id, schema.driverNotesTable.lastHiddenByUserId),
    )
    .where(
      and(
        eq(schema.driverNotesTable.weekStart, weekStart),
        eq(schema.driverNotesTable.kfiId, kfiId),
        sql`${schema.driverNotesTable.deletedAt} IS NULL`,
      ),
    )
    .orderBy(desc(schema.driverNotesTable.createdAt));

  // Resolve punchExists in a single round-trip: any row whose punch_id is
  // still present in `punches` is "live"; the rest get tagged "(orphaned
  // punch)" by the UI so deleting a punch doesn't lose context.
  const punchIds = [
    ...new Set(rows.map((r) => r.punchId).filter((x): x is number => x != null)),
  ];
  const livePunchIds = new Set<number>();
  if (punchIds.length > 0) {
    const live = await db
      .select({ id: schema.punchesTable.id })
      .from(schema.punchesTable)
      .where(inArray(schema.punchesTable.id, punchIds));
    for (const p of live) livePunchIds.add(p.id);
  }
  return rows.map((r) => ({
    id: r.id,
    weekStart: r.weekStart,
    kfiId: r.kfiId,
    punchId: r.punchId,
    punchExists: r.punchId == null ? true : livePunchIds.has(r.punchId),
    body: r.body,
    authorUserId: r.authorUserId,
    authorEmail: r.authorEmail ?? null,
    authorRole: r.authorRole,
    createdAt: new Date(r.createdAt).toISOString(),
    // null when the note has never been hidden. When set, the note was
    // previously soft-deleted and later restored — the driver-detail panel
    // renders a "previously hidden by …" tag for admin viewers.
    lastHiddenAt:
      r.lastHiddenAt == null ? null : new Date(r.lastHiddenAt).toISOString(),
    lastHiddenByEmail: r.lastHiddenByEmail ?? null,
  }));
}

weeksRouter.get(
  "/weeks/:weekStart/drivers/:kfiId/notes",
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    const kfiId = String(req.params.kfiId ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    res.json(await loadNotesForDriverWeek(weekStart, kfiId));
  },
);

weeksRouter.post(
  "/weeks/:weekStart/drivers/:kfiId/notes",
  async (req, res) => {
    const weekStart = String(req.params.weekStart ?? "");
    const kfiId = String(req.params.kfiId ?? "");
    if (!isWeek(weekStart)) {
      res.status(400).json({ error: "Invalid week" });
      return;
    }
    const parsed = CreateDriverNoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const user = (req as Request & { user?: typeof schema.usersTable.$inferSelect }).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    // Author role is denormalized at write-time so changing the user's role
    // later doesn't retroactively rewrite history. Admins are tagged 'admin'
    // even when their underlying `role` column says 'reviewer' /
    // 'supervisor', so the UI can render an Admin badge.
    const authorRole = user.isAdmin
      ? "admin"
      : user.role === "supervisor"
        ? "supervisor"
        : "reviewer";
    const punchId =
      typeof parsed.data.punchId === "number" && Number.isFinite(parsed.data.punchId)
        ? parsed.data.punchId
        : null;
    if (punchId != null) {
      const owner = await db
        .select({ id: schema.punchesTable.id })
        .from(schema.punchesTable)
        .where(
          and(
            eq(schema.punchesTable.id, punchId),
            eq(schema.punchesTable.weekStart, weekStart),
            eq(schema.punchesTable.kfiId, kfiId),
          ),
        )
        .limit(1);
      if (owner.length === 0) {
        res
          .status(400)
          .json({ error: "punchId does not belong to this driver-week" });
        return;
      }
    }
    const inserted = await db
      .insert(schema.driverNotesTable)
      .values({
        weekStart,
        kfiId,
        punchId,
        body: parsed.data.body,
        authorUserId: user.id,
        authorRole,
      })
      .returning();
    const row = inserted[0];
    let punchExists = true;
    if (row.punchId != null) {
      const live = await db
        .select({ id: schema.punchesTable.id })
        .from(schema.punchesTable)
        .where(eq(schema.punchesTable.id, row.punchId))
        .limit(1);
      punchExists = live.length > 0;
    }
    publishRealtime({
      type: "note-changed",
      weekStart: row.weekStart,
      kfiId: row.kfiId,
      action: "create",
      actor: actorRef(req),
    });
    res.json({
      id: row.id,
      weekStart: row.weekStart,
      kfiId: row.kfiId,
      punchId: row.punchId,
      punchExists,
      body: row.body,
      authorUserId: row.authorUserId,
      authorEmail: user.email,
      authorRole: row.authorRole,
      createdAt: new Date(row.createdAt).toISOString(),
      // Freshly-created notes have never been hidden.
      lastHiddenAt: null,
      lastHiddenByEmail: null,
    });
  },
);

weeksRouter.delete("/notes/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const userId = req.session.userId ?? null;
  let softDeleted: { weekStart: string; kfiId: string } | null = null;
  await db.transaction(async (tx) => {
    const existing = await tx.query.driverNotesTable.findFirst({
      where: eq(schema.driverNotesTable.id, id),
    });
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.deletedAt) {
      res.status(204).end();
      return;
    }
    // Also stamp last_hidden_{at,by_user_id} — these columns are
    // intentionally NOT cleared on restore, so the driver-detail panel can
    // surface a "previously hidden by …" tag once an admin restores the
    // note. deleted_{at,by_user_id} still drive the "currently hidden"
    // state.
    const now = new Date();
    await tx
      .update(schema.driverNotesTable)
      .set({
        deletedAt: now,
        deletedByUserId: userId,
        lastHiddenAt: now,
        lastHiddenByUserId: userId,
      })
      .where(eq(schema.driverNotesTable.id, id));
    // Audit the soft-delete on the user_audit_log so admin actions on notes
    // are append-only attributable. targetUserId is the note's author so the
    // admin users page surfaces "your note was hidden by …" in context.
    await tx.insert(schema.userAuditLogTable).values({
      actorUserId: userId,
      targetUserId: existing.authorUserId ?? null,
      targetEmail: null,
      action: "soft-delete-note",
    });
    softDeleted = { weekStart: existing.weekStart, kfiId: existing.kfiId };
  });
  // Publish AFTER the transaction commits so a rolled-back delete never
  // fans out a ghost realtime event to other dispatchers.
  if (softDeleted) {
    const { weekStart, kfiId } = softDeleted as { weekStart: string; kfiId: string };
    publishRealtime({
      type: "note-changed",
      weekStart,
      kfiId,
      action: "soft-delete",
      actor: actorRef(req),
    });
  }
  if (!res.headersSent) res.status(204).end();
});

weeksRouter.post("/notes/:id/restore", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const userId = req.session.userId ?? null;
  let restored: { weekStart: string; kfiId: string } | null = null as { weekStart: string; kfiId: string } | null;
  await db.transaction(async (tx) => {
    const existing = await tx.query.driverNotesTable.findFirst({
      where: eq(schema.driverNotesTable.id, id),
    });
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!existing.deletedAt) {
      res.status(409).json({ error: "Note is not currently soft-deleted" });
      return;
    }
    await tx
      .update(schema.driverNotesTable)
      .set({ deletedAt: null, deletedByUserId: null })
      .where(eq(schema.driverNotesTable.id, id));
    // Mirror the soft-delete audit pattern: targetUserId is the note's
    // original author so the admin users page surfaces "your note was
    // restored by …" alongside the hide entry.
    await tx.insert(schema.userAuditLogTable).values({
      actorUserId: userId,
      targetUserId: existing.authorUserId ?? null,
      targetEmail: null,
      action: "restore-note",
    });
    restored = { weekStart: existing.weekStart, kfiId: existing.kfiId };
  });
  if (res.headersSent || restored == null) return;
  publishRealtime({
    type: "note-changed",
    weekStart: restored.weekStart,
    kfiId: restored.kfiId,
    action: "restore",
    actor: actorRef(req),
  });
  // Re-load via the existing helper so the response shape matches the
  // driver-detail "live" notes payload exactly.
  const rows = await loadNotesForDriverWeek(restored.weekStart, restored.kfiId);
  const row = rows.find((r) => r.id === id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

async function markHiddenNotesSeenFor(userId: number | null | undefined) {
  if (!userId) return;
  // Stamp the requesting admin's "last viewed" timestamp so the unseen-count
  // badge resets to zero. Idempotent and racy-safe — losing the race just
  // means a slightly older timestamp wins and a small badge re-appears.
  await db
    .update(schema.usersTable)
    .set({ notesHiddenLastSeenAt: new Date() })
    .where(eq(schema.usersTable.id, userId));
}

async function unseenHiddenNotesCountFor(userId: number | null | undefined) {
  if (!userId) return { count: 0, lastSeenAt: null as string | null };
  const me = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.id, userId),
    columns: { notesHiddenLastSeenAt: true },
  });
  const lastSeenAt = me?.notesHiddenLastSeenAt ?? null;
  // Only count notes still soft-deleted and hidden after `lastSeenAt`. If the
  // admin has never opened the page, every currently-hidden note counts.
  const whereClause = lastSeenAt
    ? and(
        isNotNull(schema.driverNotesTable.deletedAt),
        gt(schema.driverNotesTable.deletedAt, lastSeenAt),
      )
    : isNotNull(schema.driverNotesTable.deletedAt);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.driverNotesTable)
    .where(whereClause);
  return {
    count: row?.count ?? 0,
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
  };
}

weeksRouter.get(
  "/admin/notes/hidden-unseen-count",
  requireAdmin,
  async (req, res) => {
    const result = await unseenHiddenNotesCountFor(req.session.userId);
    res.json(result);
  },
);

weeksRouter.post(
  "/admin/notes/mark-hidden-seen",
  requireAdmin,
  async (req, res) => {
    await markHiddenNotesSeenFor(req.session.userId);
    const result = await unseenHiddenNotesCountFor(req.session.userId);
    res.json(result);
  },
);

weeksRouter.get("/admin/notes/deleted", requireAdmin, async (req, res) => {
  const limitParam = Number(req.query.limit);
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500
      ? limitParam
      : 100;
  // Visiting the page is treated as acknowledgement: stamp last-seen so the
  // badge resets. Doing it here (rather than only on an explicit POST) means
  // the existing admin page Just Works without a separate mutation.
  await markHiddenNotesSeenFor(req.session.userId);
  const author = alias(schema.usersTable, "author");
  const deleter = alias(schema.usersTable, "deleter");
  const rows = await db
    .select({
      id: schema.driverNotesTable.id,
      weekStart: schema.driverNotesTable.weekStart,
      kfiId: schema.driverNotesTable.kfiId,
      punchId: schema.driverNotesTable.punchId,
      body: schema.driverNotesTable.body,
      authorUserId: schema.driverNotesTable.authorUserId,
      authorEmail: author.email,
      authorRole: schema.driverNotesTable.authorRole,
      createdAt: schema.driverNotesTable.createdAt,
      deletedAt: schema.driverNotesTable.deletedAt,
      deletedByUserId: schema.driverNotesTable.deletedByUserId,
      deletedByEmail: deleter.email,
    })
    .from(schema.driverNotesTable)
    .leftJoin(author, eq(author.id, schema.driverNotesTable.authorUserId))
    .leftJoin(deleter, eq(deleter.id, schema.driverNotesTable.deletedByUserId))
    .where(isNotNull(schema.driverNotesTable.deletedAt))
    .orderBy(desc(schema.driverNotesTable.deletedAt))
    .limit(limit);

  // Resolve punchExists in one round-trip so the UI can render an
  // "(orphaned punch)" tag when the underlying punch row is gone.
  const punchIds = [
    ...new Set(rows.map((r) => r.punchId).filter((x): x is number => x != null)),
  ];
  const livePunchIds = new Set<number>();
  if (punchIds.length > 0) {
    const live = await db
      .select({ id: schema.punchesTable.id })
      .from(schema.punchesTable)
      .where(inArray(schema.punchesTable.id, punchIds));
    for (const p of live) livePunchIds.add(p.id);
  }
  res.json(
    rows.map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      kfiId: r.kfiId,
      punchId: r.punchId,
      punchExists: r.punchId == null ? true : livePunchIds.has(r.punchId),
      body: r.body,
      authorUserId: r.authorUserId,
      authorEmail: r.authorEmail ?? null,
      authorRole: r.authorRole,
      createdAt: new Date(r.createdAt).toISOString(),
      deletedAt: r.deletedAt ? new Date(r.deletedAt).toISOString() : null,
      deletedByUserId: r.deletedByUserId,
      deletedByEmail: r.deletedByEmail ?? null,
    })),
  );
});

// ---------------------------------------------------------------------------
// Timezone management — per-driver `drivers.display_tz`, per-customer
// `customer_tz_preferences`, plus per-driver Connecteam re-pull and a
// bulk shift-existing-punches helper for fixing a wrong-tz driver-week
// without re-uploading.
// ---------------------------------------------------------------------------

weeksRouter.get("/timezones/allowed", (_req, res) => {
  res.json({ allowed: [...ALLOWED_TZS] });
});

weeksRouter.patch(
  "/drivers/:kfiId/timezone",
  requireSupervisorOrAdmin,
  async (req, res) => {
    const kfiId = String(req.params.kfiId ?? "").trim();
    if (!kfiId) {
      res.status(400).json({ error: "kfiId is required" });
      return;
    }
    const body = req.body as { displayTz?: unknown } | undefined;
    const raw = body?.displayTz;
    let displayTz: string | null;
    if (raw === null || raw === "" || raw === undefined) {
      displayTz = null;
    } else if (typeof raw === "string" && isAllowedTz(raw)) {
      displayTz = raw;
    } else {
      res
        .status(400)
        .json({ error: `displayTz must be null or one of ${ALLOWED_TZS.join(", ")}` });
      return;
    }
    const driver = await db.query.driversTable.findFirst({
      where: eq(schema.driversTable.kfiId, kfiId),
    });
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const userId = req.session.userId ?? null;
    const [row] = await db
      .update(schema.driversTable)
      .set({
        displayTz,
        displayTzUpdatedBy: userId,
        displayTzUpdatedAt: new Date(),
      })
      .where(eq(schema.driversTable.kfiId, kfiId))
      .returning();
    res.json({
      kfiId: row.kfiId,
      name: row.name,
      customer: row.customer,
      ctUserId: row.ctUserId ?? null,
      isDriver: row.isDriver,
      displayTz: row.displayTz ?? null,
      effectiveDispTz: resolveDispTz(row.kfiId, row.displayTz ?? null),
    });
  },
);

weeksRouter.post(
  "/weeks/:weekStart/drivers/:kfiId/refresh-connecteam",
  requireSupervisorOrAdmin,
  async (req, res) => {
    const weekStart = String(req.params.weekStart);
    const kfiId = String(req.params.kfiId ?? "").trim();
    if (!isWeek(weekStart) || !kfiId) {
      res.status(400).json({ error: "Invalid week or kfiId" });
      return;
    }
    if (!(await assertNotLocked(res, weekStart, kfiId))) return;
    const { startDate, endDate } = await ensureWeek(weekStart);
    const driver = await db.query.driversTable.findFirst({
      where: eq(schema.driversTable.kfiId, kfiId),
    });
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    try {
      const driverTzByKfi = await loadDriverTzMap();
      const ctUserIdToKfi = new Map<number, string>();
      if (driver.ctUserId != null) ctUserIdToKfi.set(driver.ctUserId, kfiId);
      // Pull every shift for the week, then keep only this driver's rows.
      const allPunches = await fetchPunchesForWeek(
        startDate,
        endDate,
        ctUserIdToKfi,
        driverTzByKfi,
      );
      const punches = allPunches.filter((p) => p.kfiId === kfiId);
      const seen = new Map<string, (typeof punches)[number]>();
      for (const p of punches) seen.set(p.ctExternalKey, p);
      const deduped = [...seen.values()];
      const refreshedAt = new Date();
      await db.transaction(async (tx) => {
        // Replace only this driver's non-manual, non-edited Driver-source rows.
        await tx
          .delete(schema.punchesTable)
          .where(
            and(
              eq(schema.punchesTable.weekStart, startDate),
              eq(schema.punchesTable.kfiId, kfiId),
              eq(schema.punchesTable.source, "Driver"),
              eq(schema.punchesTable.isManual, false),
              ne(schema.punchesTable.edited, true),
            ),
          );
        const keptKeys = new Set(
          (
            await tx
              .select({ key: schema.punchesTable.ctExternalKey })
              .from(schema.punchesTable)
              .where(
                and(
                  eq(schema.punchesTable.weekStart, startDate),
                  eq(schema.punchesTable.kfiId, kfiId),
                  eq(schema.punchesTable.source, "Driver"),
                ),
              )
          )
            .map((r) => r.key)
            .filter((k): k is string => Boolean(k)),
        );
        const toInsert = deduped.filter((p) => !keptKeys.has(p.ctExternalKey));
        if (toInsert.length > 0) {
          await tx.insert(schema.punchesTable).values(
            toInsert.map((p) => ({
              weekStart: startDate,
              kfiId: p.kfiId,
              customer: null,
              source: "Driver",
              date: p.date,
              clockIn: p.clockIn,
              clockOut: p.clockOut,
              hours: String(p.hours),
              dispTz: p.dispTz,
              isManual: false,
              ctExternalKey: p.ctExternalKey,
              createdBy: req.session.userId ?? null,
            })),
          );
        }
        // Refresh the per-day snapshot for this driver only.
        const snapshotByDate = new Map<string, number>();
        for (const p of deduped) {
          snapshotByDate.set(
            p.date,
            Math.round(((snapshotByDate.get(p.date) ?? 0) + p.hours) * 100) /
              100,
          );
        }
        await tx
          .delete(schema.connecteamDailySnapshotsTable)
          .where(
            and(
              eq(schema.connecteamDailySnapshotsTable.weekStart, startDate),
              eq(schema.connecteamDailySnapshotsTable.kfiId, kfiId),
            ),
          );
        if (snapshotByDate.size > 0) {
          await tx.insert(schema.connecteamDailySnapshotsTable).values(
            [...snapshotByDate.entries()].map(([date, hours]) => ({
              weekStart: startDate,
              kfiId,
              date,
              hours: String(hours),
              refreshedAt,
            })),
          );
        }
      });
      publishRealtime({
        type: "punch-changed",
        weekStart: startDate,
        kfiId,
        action: "update",
        actor: actorRef(req),
      });
      res.json({
        driversFound: 1,
        punchesUpserted: deduped.length,
        refreshedAt: refreshedAt.toISOString(),
      });
    } catch (err) {
      req.log.error({ err, kfiId }, "Per-driver Connecteam refresh failed");
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : "Connecteam error" });
    }
  },
);

weeksRouter.post(
  "/weeks/:weekStart/drivers/:kfiId/shift-punches",
  requireSupervisorOrAdmin,
  async (req, res) => {
    const weekStart = String(req.params.weekStart);
    const kfiId = String(req.params.kfiId ?? "").trim();
    if (!isWeek(weekStart) || !kfiId) {
      res.status(400).json({ error: "Invalid week or kfiId" });
      return;
    }
    if (!(await assertNotLocked(res, weekStart, kfiId))) return;
    const body = req.body as {
      offsetHours?: unknown;
      source?: unknown;
      newDispTz?: unknown;
    };
    const offsetHours = Number(body.offsetHours);
    if (!Number.isFinite(offsetHours) || offsetHours === 0) {
      res.status(400).json({ error: "offsetHours must be a non-zero number" });
      return;
    }
    if (Math.abs(offsetHours) > 12) {
      res.status(400).json({ error: "offsetHours out of range (-12..12)" });
      return;
    }
    const sourceFilter =
      body.source === "Driver" || body.source === "Customer"
        ? body.source
        : null;
    const newDispTz =
      typeof body.newDispTz === "string" && isAllowedTz(body.newDispTz)
        ? body.newDispTz
        : null;
    const conds: SQL[] = [
      eq(schema.punchesTable.weekStart, weekStart),
      eq(schema.punchesTable.kfiId, kfiId),
    ];
    if (sourceFilter) conds.push(eq(schema.punchesTable.source, sourceFilter));
    const rows = await db
      .select()
      .from(schema.punchesTable)
      .where(and(...conds));
    if (rows.length === 0) {
      res.json({ shifted: 0 });
      return;
    }
    const offsetMs = offsetHours * 3_600_000;
    const shift = (s: string): string => {
      const ms = localStrToSortMs(s);
      if (ms == null) return s;
      const next = new Date(ms + offsetMs);
      const yr = next.getUTCFullYear();
      const mo = String(next.getUTCMonth() + 1).padStart(2, "0");
      const dy = String(next.getUTCDate()).padStart(2, "0");
      let hh = next.getUTCHours();
      const mm = String(next.getUTCMinutes()).padStart(2, "0");
      const ap = hh >= 12 ? "PM" : "AM";
      hh = hh % 12;
      if (hh === 0) hh = 12;
      return `${yr}-${mo}-${dy} ${hh}:${mm} ${ap}`;
    };
    const userId = req.session.userId ?? null;
    await db.transaction(async (tx) => {
      for (const r of rows) {
        const newIn = shift(r.clockIn);
        const newOut = shift(r.clockOut);
        const newDate = newIn.slice(0, 10);
        await tx
          .update(schema.punchesTable)
          .set({
            clockIn: newIn,
            clockOut: newOut,
            date: newDate,
            edited: true,
            updatedBy: userId,
            ...(newDispTz ? { dispTz: newDispTz } : {}),
          })
          .where(eq(schema.punchesTable.id, r.id));
      }
    });
    publishRealtime({
      type: "punch-changed",
      weekStart,
      kfiId,
      action: "update",
      actor: actorRef(req),
    });
    res.json({ shifted: rows.length });
  },
);

weeksRouter.get("/customer-tz-preferences", requireAuth, async (_req, res) => {
  const rows = await db
    .select({
      customer: schema.customerTzPreferencesTable.customer,
      displayTz: schema.customerTzPreferencesTable.displayTz,
      updatedAt: schema.customerTzPreferencesTable.updatedAt,
      updatedBy: schema.customerTzPreferencesTable.updatedBy,
    })
    .from(schema.customerTzPreferencesTable)
    .orderBy(asc(sql`lower(${schema.customerTzPreferencesTable.customer})`));
  const actorIds = new Set<number>();
  for (const r of rows) if (r.updatedBy) actorIds.add(r.updatedBy);
  const emailById = new Map<number, string>();
  if (actorIds.size > 0) {
    const actors = await db
      .select({ id: schema.usersTable.id, email: schema.usersTable.email })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, [...actorIds]));
    for (const a of actors) emailById.set(a.id, a.email);
  }
  res.json(
    rows.map((r) => ({
      customer: r.customer,
      displayTz: r.displayTz,
      updatedAt: new Date(r.updatedAt).toISOString(),
      updatedByEmail: r.updatedBy ? emailById.get(r.updatedBy) ?? null : null,
    })),
  );
});

weeksRouter.put(
  "/customer-tz-preferences",
  requireSupervisorOrAdmin,
  async (req, res) => {
    const body = req.body as { customer?: unknown; displayTz?: unknown };
    const customer =
      typeof body.customer === "string" ? body.customer.trim() : "";
    if (!customer) {
      res.status(400).json({ error: "customer is required" });
      return;
    }
    if (typeof body.displayTz !== "string" || !isAllowedTz(body.displayTz)) {
      res
        .status(400)
        .json({ error: `displayTz must be one of ${ALLOWED_TZS.join(", ")}` });
      return;
    }
    const displayTz = body.displayTz;
    const userId = req.session.userId ?? null;
    // Case-insensitive upsert: the unique index is on lower(customer), which
    // Drizzle's onConflict can't target directly, so delete-then-insert.
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.customerTzPreferencesTable)
        .where(
          sql`lower(${schema.customerTzPreferencesTable.customer}) = lower(${customer})`,
        );
      await tx.insert(schema.customerTzPreferencesTable).values({
        customer,
        displayTz,
        updatedBy: userId,
      });
    });
    res.json({ customer, displayTz });
  },
);

weeksRouter.delete(
  "/customer-tz-preferences",
  requireSupervisorOrAdmin,
  async (req, res) => {
    const customer = String(req.query.customer ?? "").trim();
    if (!customer) {
      res.status(400).json({ error: "customer is required" });
      return;
    }
    await db
      .delete(schema.customerTzPreferencesTable)
      .where(
        sql`lower(${schema.customerTzPreferencesTable.customer}) = lower(${customer})`,
      );
    res.status(204).end();
  },
);

export function serializePunch(
  p: typeof schema.punchesTable.$inferSelect,
  emailById?: Map<number, string>,
) {
  return {
    id: p.id,
    weekStart: p.weekStart,
    kfiId: p.kfiId,
    customer: p.customer,
    source: p.source,
    date: p.date,
    clockIn: p.clockIn,
    clockOut: p.clockOut,
    hours: Number(p.hours),
    payType: p.payType,
    dispTz: p.dispTz,
    isManual: p.isManual,
    edited: p.edited,
    createdByEmail:
      p.createdBy && emailById ? emailById.get(p.createdBy) ?? null : null,
    updatedByEmail:
      p.updatedBy && emailById ? emailById.get(p.updatedBy) ?? null : null,
    updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    reviewed: p.reviewedAt != null,
    reviewedAt: p.reviewedAt ? new Date(p.reviewedAt).toISOString() : null,
    reviewedByEmail:
      p.reviewedBy && emailById ? emailById.get(p.reviewedBy) ?? null : null,
  };
}

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

weeksRouter.get(
  "/weeks/:weekStart/timesheets",
  makeTimesheetsHandler({
    getWeek: async (weekStart) => {
      const week = await db.query.weeksTable.findFirst({
        where: eq(schema.weeksTable.startDate, weekStart),
      });
      if (!week) return null;
      return {
        endDate: week.endDate,
        lastRefreshedAt: week.lastRefreshedAt ?? null,
      };
    },
    getPunches: async (weekStart) =>
      db
        .select()
        .from(schema.punchesTable)
        .where(eq(schema.punchesTable.weekStart, weekStart))
        .orderBy(asc(schema.punchesTable.kfiId), asc(schema.punchesTable.date)),
    getDrivers: async () => db.select().from(schema.driversTable),
    getReviewedKfiIds: async (weekStart) => {
      const rows = await db
        .select()
        .from(schema.reviewedDriversTable)
        .where(eq(schema.reviewedDriversTable.weekStart, weekStart));
      return new Set(rows.map((r) => r.kfiId));
    },
    getNoteSummaries: async (weekStart) => {
      // Pull every non-deleted note for the week (row-level + week-level)
      // in one query, then fold into per-driver { count, weekNoteBodies }.
      // Hidden / soft-deleted notes are excluded by the deleted_at filter.
      const rows = await db
        .select({
          kfiId: schema.driverNotesTable.kfiId,
          punchId: schema.driverNotesTable.punchId,
          body: schema.driverNotesTable.body,
          createdAt: schema.driverNotesTable.createdAt,
        })
        .from(schema.driverNotesTable)
        .where(
          and(
            eq(schema.driverNotesTable.weekStart, weekStart),
            sql`${schema.driverNotesTable.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(schema.driverNotesTable.createdAt));
      const byKfi = new Map<
        string,
        { count: number; weekNoteBodies: string[] }
      >();
      for (const r of rows) {
        const entry = byKfi.get(r.kfiId) ?? { count: 0, weekNoteBodies: [] };
        entry.count += 1;
        if (r.punchId === null) entry.weekNoteBodies.push(r.body);
        byKfi.set(r.kfiId, entry);
      }
      return byKfi;
    },
  }),
);

weeksRouter.get("/weeks/:weekStart/report", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isWeek(weekStart)) {
    res.status(400).send("Invalid week");
    return;
  }
  const week = await db.query.weeksTable.findFirst({
    where: eq(schema.weeksTable.startDate, weekStart),
  });
  const endDate = week?.endDate ?? weekEndOf(weekStart);
  const punches = await db
    .select()
    .from(schema.punchesTable)
    .where(eq(schema.punchesTable.weekStart, weekStart))
    .orderBy(asc(schema.punchesTable.kfiId), asc(schema.punchesTable.date));
  const drivers = await db.select().from(schema.driversTable);
  const driverById = new Map(drivers.map((d) => [d.kfiId, d]));
  const reviewedRows = await db
    .select()
    .from(schema.reviewedDriversTable)
    .where(eq(schema.reviewedDriversTable.weekStart, weekStart));
  const reviewed = new Set(reviewedRows.map((r) => r.kfiId));
  const noteCountRows = await db
    .select({
      kfiId: schema.driverNotesTable.kfiId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.driverNotesTable)
    .where(
      and(
        eq(schema.driverNotesTable.weekStart, weekStart),
        sql`${schema.driverNotesTable.deletedAt} IS NULL`,
      ),
    )
    .groupBy(schema.driverNotesTable.kfiId);
  const reportNoteCountByKfi = new Map<string, number>();
  for (const r of noteCountRows)
    reportNoteCountByKfi.set(r.kfiId, Number(r.count));
  const byKfi = new Map<string, typeof punches>();
  for (const p of punches) {
    const arr = byKfi.get(p.kfiId) ?? [];
    arr.push(p);
    byKfi.set(p.kfiId, arr);
  }
  type Row = {
    kfiId: string;
    name: string;
    customer: string;
    driverHours: number;
    customerHours: number;
    regularHours: number;
    overtimeHours: number;
    reviewed: boolean;
    noteCount: number;
  };
  const rows: Row[] = [];
  let totDriver = 0,
    totCust = 0,
    totRt = 0,
    totOt = 0;
  for (const [kfiId, ps] of byKfi.entries()) {
    const t = computeDriverTotals(ps);
    if (t.totalHours <= 0) continue;
    const meta = driverById.get(kfiId);
    totDriver += t.totalDriver;
    totCust += t.totalCustomer;
    totRt += t.regularHours;
    totOt += t.overtimeHours;
    rows.push({
      kfiId,
      name: meta?.name ?? `Driver ${kfiId}`,
      customer: meta?.customer ?? ps[0]?.customer ?? "Unknown",
      driverHours: t.totalDriver,
      customerHours: t.totalCustomer,
      regularHours: t.regularHours,
      overtimeHours: t.overtimeHours,
      reviewed: reviewed.has(kfiId),
      noteCount: reportNoteCountByKfi.get(kfiId) ?? 0,
    });
  }
  rows.sort(
    (a, b) =>
      a.customer.localeCompare(b.customer) || a.name.localeCompare(b.name),
  );
  const groups = [...new Set(rows.map((r) => r.customer))]
    .sort()
    .map((c) => ({ customer: c, drivers: rows.filter((r) => r.customer === c) }));

  const groupHtml = groups
    .map(
      (g) => `
    <h2>${esc(g.customer)} <span class="count">(${g.drivers.length} drivers)</span></h2>
    <table>
      <thead><tr>
        <th>Driver</th><th>KFI ID</th>
        <th class="num">Driver Hrs</th><th class="num">Customer Hrs</th>
        <th class="num">Diff</th><th class="num">Regular</th>
        <th class="num">Overtime</th><th class="num">Notes</th><th>Reviewed</th>
      </tr></thead>
      <tbody>
        ${g.drivers
          .map((d) => {
            const diff = Math.abs(d.driverHours - d.customerHours);
            const mismatch =
              d.driverHours > 0 && d.customerHours > 0 && diff > 0.05;
            return `<tr${mismatch ? ' class="mismatch"' : ""}>
              <td>${esc(d.name)}</td>
              <td class="mono">${esc(d.kfiId)}</td>
              <td class="num">${d.driverHours.toFixed(2)}</td>
              <td class="num">${d.customerHours.toFixed(2)}</td>
              <td class="num">${mismatch ? diff.toFixed(2) : "-"}</td>
              <td class="num">${d.regularHours.toFixed(2)}</td>
              <td class="num${d.overtimeHours > 0 ? " ot" : ""}">${d.overtimeHours > 0 ? d.overtimeHours.toFixed(2) : "-"}</td>
              <td class="num${d.noteCount > 0 ? " notes" : ""}">${d.noteCount > 0 ? d.noteCount : "-"}</td>
              <td>${d.reviewed ? "✓" : ""}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>KFI OT Worksheet — Week of ${esc(weekStart)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #0f172a; margin: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #cbd5e1; color: #0e7490; }
  h2 .count { font-weight: 400; color: #64748b; font-size: 13px; }
  .meta { color: #475569; font-size: 13px; margin-bottom: 16px; }
  .totals { display: flex; gap: 24px; flex-wrap: wrap; padding: 12px 16px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; margin-bottom: 16px; }
  .totals div { font-size: 12px; text-transform: uppercase; color: #475569; letter-spacing: 0.04em; }
  .totals strong { display: block; font-size: 20px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #0f172a; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  th { background: #f8fafc; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; }
  td.num, th.num { text-align: right; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  td.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #475569; font-size: 12px; }
  td.ot { color: #b45309; font-weight: 600; }
  td.notes { color: #3730a3; font-weight: 600; }
  tr.mismatch { background: #fef2f2; }
  tr.mismatch td.num:nth-child(5) { color: #b91c1c; font-weight: 600; }
  .actions { margin-bottom: 16px; }
  .actions button { font-size: 13px; padding: 6px 12px; border: 1px solid #cbd5e1; background: #fff; border-radius: 4px; cursor: pointer; }
  @media print { .actions { display: none; } body { margin: 0.5in; } h2 { break-after: avoid; } table { break-inside: avoid; } }
</style>
</head><body>
<div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
<h1>KFI Driver OT Worksheet</h1>
<div class="meta">Week of <strong>${esc(weekStart)}</strong> through <strong>${esc(endDate)}</strong>${week?.lastRefreshedAt ? ` · last Connecteam refresh: ${esc(new Date(week.lastRefreshedAt).toLocaleString())}` : ""}</div>
<div class="totals">
  <div>Active Drivers<strong>${rows.length}</strong></div>
  <div>Total Hours<strong>${(totDriver + totCust).toFixed(2)}</strong></div>
  <div>Driver Source<strong>${totDriver.toFixed(2)}</strong></div>
  <div>Customer Source<strong>${totCust.toFixed(2)}</strong></div>
  <div>Regular<strong>${totRt.toFixed(2)}</strong></div>
  <div>Overtime<strong>${totOt.toFixed(2)}</strong></div>
</div>
${groupHtml || "<p>No active drivers found for this week.</p>"}
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ---------------------------------------------------------------------------
// Realtime: SSE event stream + presence + editing intent.
// Auth is provided by the router-level `requireAuth` middleware. The bus is
// in-memory and single-process — see lib/realtime.ts for the Postgres
// LISTEN/NOTIFY upgrade path documented in replit.md.
// ---------------------------------------------------------------------------

weeksRouter.get("/events", (req, res) => {
  const actor = actorRef(req);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const weekStart = String(req.query.weekStart ?? "");
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "weekStart query param is required (YYYY-MM-DD Sunday)" });
    return;
  }
  const kfiId =
    typeof req.query.kfiId === "string" && req.query.kfiId.trim()
      ? req.query.kfiId.trim()
      : null;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable nginx-style buffering so events flush immediately through any
  // upstream proxy that honors this hint.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // Initial comment primes the stream so EventSource considers it open.
  res.write(": connected\n\n");

  const unsubscribe = subscribeRealtime({
    res,
    userId: actor.userId,
    email: actor.email,
    weekStart,
    kfiId,
  });
  req.on("close", () => {
    unsubscribe();
  });
});

weeksRouter.post("/presence", (req, res) => {
  const actor = actorRef(req);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const weekStart = String(req.body?.weekStart ?? "");
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "weekStart is required" });
    return;
  }
  const kfiIdRaw = req.body?.kfiId;
  const kfiId = typeof kfiIdRaw === "string" && kfiIdRaw.trim() ? kfiIdRaw.trim() : null;
  const viewers = upsertPresence({
    userId: actor.userId,
    email: actor.email,
    weekStart,
    kfiId,
  });
  res.json({ viewers });
});

weeksRouter.get("/presence", (req, res) => {
  const weekStart = String(req.query.weekStart ?? "");
  if (!isWeek(weekStart)) {
    res.status(400).json({ error: "weekStart is required" });
    return;
  }
  const kfiIdRaw = req.query.kfiId;
  const kfiId = typeof kfiIdRaw === "string" && kfiIdRaw.length > 0 ? kfiIdRaw : null;
  res.json({ viewers: getPresence(weekStart, kfiId) });
});

weeksRouter.post("/editing", (req, res) => {
  const actor = actorRef(req);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const weekStart = String(req.body?.weekStart ?? "");
  const kfiId = String(req.body?.kfiId ?? "").trim();
  if (!isWeek(weekStart) || !kfiId) {
    res.status(400).json({ error: "weekStart and kfiId are required" });
    return;
  }
  const action = req.body?.action === "stop" ? "stop" : "start";
  const punchIdRaw = req.body?.punchId;
  const punchId =
    typeof punchIdRaw === "number" && Number.isFinite(punchIdRaw)
      ? punchIdRaw
      : null;
  if (action === "start") {
    startEditing({ userId: actor.userId, email: actor.email, weekStart, kfiId, punchId });
  } else {
    stopEditing({ userId: actor.userId, email: actor.email, weekStart, kfiId, punchId });
  }
  res.json({ ok: true });
});

weeksRouter.get("/admin/realtime", requireAdmin, (_req, res) => {
  res.json(realtimeSnapshot());
});
