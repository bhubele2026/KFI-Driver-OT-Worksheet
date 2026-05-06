import { Router } from "express";
import multer from "multer";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  ConfirmNewCustomerFileBody,
  CreateManualPunchBody,
  SetReviewedBody,
} from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import { requireAuth, requireAdmin } from "../lib/auth.js";
import {
  fetchAllTimeClocks,
  fetchAllUsers,
  fetchPunchesForWeek,
  looksLikeRosterDateJunk,
} from "../lib/connecteam.js";
import { TIME_CLOCKS } from "../lib/mappings.js";
import {
  computeChecks,
  computeDailyTotals,
  computeDriverTotals,
  defaultDispTz,
} from "../lib/hoursEngine.js";
import {
  KNOWN_CUSTOMERS,
  detectAndParseFile,
} from "../lib/parsers/index.js";
import { detectCustomerFromFileName } from "../lib/parsers/customers.js";
import { aiExtractRows } from "../lib/parsers/aiExtract.js";
import { topMatches } from "../lib/parsers/fuzzy.js";
import { mondayOf, weekEndOf } from "../lib/time.js";

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
  const monday = mondayOf(weekStart);
  const end = weekEndOf(monday);
  await db
    .insert(schema.weeksTable)
    .values({ startDate: monday, endDate: end })
    .onConflictDoNothing();
  return { startDate: monday, endDate: end };
}

async function recordAttempt(
  weekStart: string,
  customer: string,
  fileName: string,
  error: string | null,
  source: "parser" | "ai",
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
  const reviewed = new Set(
    (
      await db
        .select()
        .from(schema.reviewedDriversTable)
        .where(eq(schema.reviewedDriversTable.weekStart, weekStart))
    ).map((r) => r.kfiId),
  );

  // Resolve actor user emails for last-touched + last-refreshed surfacing.
  const actorIds = new Set<number>();
  if (week?.lastRefreshedBy) actorIds.add(week.lastRefreshedBy);
  for (const p of punches) {
    if (p.updatedBy) actorIds.add(p.updatedBy);
    if (p.createdBy) actorIds.add(p.createdBy);
  }
  for (const d of deletions) {
    if (d.deletedBy) actorIds.add(d.deletedBy);
  }
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
    hasOvertime: boolean;
    lastTouchedByEmail: string | null;
    lastTouchedAt: string | null;
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
      hasOvertime: t.hasOvertime,
      lastTouchedByEmail: lastActorId
        ? actorEmailById.get(lastActorId) ?? null
        : null,
      lastTouchedAt,
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
  }
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
    },
    weekStart,
    endDate,
    punches: punches.map((p) => serializePunch(p, actorEmailById)),
    dailyTotals: computeDailyTotals(punches, weekStart, endDate),
    totals: {
      driverHours: totals.totalDriver,
      customerHours: totals.totalCustomer,
      totalHours: totals.totalHours,
      regularHours: totals.regularHours,
      overtimeHours: totals.overtimeHours,
    },
    checks: computeChecks(punches),
    reviewed: Boolean(reviewed),
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
    const punches = await fetchPunchesForWeek(
      startDate,
      endDate,
      ctUserIdToKfi,
    );
    // De-dupe by ctExternalKey before inserting to avoid mid-batch aborts.
    const uniqByKey = new Map<string, (typeof punches)[number]>();
    for (const p of punches) uniqByKey.set(p.ctExternalKey, p);
    const dedupedPunches = [...uniqByKey.values()];
    const refreshedAt = new Date();
    // Wrap delete + insert + week-update in a single transaction so a partial
    // failure never leaves the week with no driver punches.
    await db.transaction(async (tx) => {
      // Preserve manual rows AND any imported rows the dispatcher edited inline.
      await tx
        .delete(schema.punchesTable)
        .where(
          and(
            eq(schema.punchesTable.weekStart, startDate),
            eq(schema.punchesTable.source, "Driver"),
            eq(schema.punchesTable.isManual, false),
            ne(schema.punchesTable.edited, true),
          ),
        );
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
      const toInsert = dedupedPunches.filter(
        (p) => !keptKeys.has(p.ctExternalKey),
      );
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
      await tx
        .update(schema.weeksTable)
        .set({
          lastRefreshedAt: refreshedAt,
          lastRefreshedBy: req.session.userId ?? null,
        })
        .where(eq(schema.weeksTable.startDate, startDate));
    });
    res.json({
      driversFound: users.length,
      punchesUpserted: punches.length,
      refreshedAt: refreshedAt.toISOString(),
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
    const fileName = req.file.originalname;
    let result;
    try {
      result = await detectAndParseFile(
        fileName,
        req.file.buffer,
        kfiSet,
        startDate,
      );
    } catch (err) {
      req.log.error({ err, fileName }, "Parse error");
      const msg = err instanceof Error ? err.message : "Could not parse file";
      // Best-effort: try to attribute to a known customer for status display.
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
        "Customer file parsed to zero punches",
      );
      const msg = `Detected customer "${result.customer}" but parsed 0 punches. The file format may have changed, or no rows match the loaded driver roster.`;
      await recordAttempt(startDate, result.customer, fileName, msg, "parser");
      res.status(400).json({ error: msg });
      return;
    }
    // Transactional swap: delete the existing customer-source rows for this
    // (week, customer) and insert the new batch atomically.
    await db.transaction(async (tx) => {
      // Preserve manual rows AND inline-edited customer rows on re-upload.
      await tx
        .delete(schema.punchesTable)
        .where(
          and(
            eq(schema.punchesTable.weekStart, startDate),
            eq(schema.punchesTable.source, "Customer"),
            eq(schema.punchesTable.customer, result.customer),
            eq(schema.punchesTable.isManual, false),
            ne(schema.punchesTable.edited, true),
          ),
        );
      if (result.punches.length > 0) {
        await tx.insert(schema.punchesTable).values(
          result.punches.map((p) => ({
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
            fileOrigin: req.file!.originalname,
            createdBy: req.session.userId ?? null,
          })),
        );
      }
    });
    await recordAttempt(startDate, result.customer, fileName, null, "parser");
    res.json({
      customer: result.customer,
      fileName,
      punchesUpserted: result.punches.length,
    });
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
      isAiImported: false,
      aiImportWeekCount: aiWeekCountByCustomer.get(c.displayName) ?? 0,
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
      isAiImported: true,
      aiImportWeekCount: aiWeekCountByCustomer.get(name) ?? 0,
    };
  });
  res.json([...out, ...aiOnly]);
});

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
    const suggestions = [...seen.entries()].map(([driverNameOnDoc, badgeOrId]) => ({
      driverNameOnDoc,
      badgeOrId,
      matches: topMatches(driverNameOnDoc, drivers, 5),
    }));
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

  const unmappedNames = new Set<string>();
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
      dispTz: defaultDispTz(kfiId),
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.punchesTable)
      .where(
        and(
          eq(schema.punchesTable.weekStart, startDate),
          eq(schema.punchesTable.source, "Customer"),
          eq(schema.punchesTable.customer, customer),
          eq(schema.punchesTable.isManual, false),
          ne(schema.punchesTable.edited, true),
        ),
      );
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

  res.json({
    customer,
    imported: toInsert.length,
    skippedUnmapped: skipped,
    unmappedNames: [...unmappedNames],
  });
});

weeksRouter.get(
  "/admin/ai-extract-samples",
  requireAdmin,
  async (req, res) => {
    const customer = typeof req.query.customer === "string" ? req.query.customer : null;
    const whereClauses = [
      sql`${schema.aiExtractSamplesTable.expiresAt} > now()`,
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
        uploadedByEmail: r.uploadedBy
          ? actorEmailById.get(r.uploadedBy) ?? null
          : null,
      })),
    );
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
        sql`${schema.aiExtractSamplesTable.expiresAt} > now()`,
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
  const dispTz = parsed.data.dispTz || defaultDispTz(parsed.data.kfiId);
  // Hours are computed client-side display, but we store the difference in
  // wall-clock so the engine can compute totals.
  const ms =
    new Date(`${parsed.data.date} ${parsed.data.clockOut}`).getTime() -
    new Date(`${parsed.data.date} ${parsed.data.clockIn}`).getTime();
  let hours = 0;
  if (!isNaN(ms) && ms > 0) hours = Math.round((ms / 3_600_000) * 1000) / 1000;
  const [row] = await db
    .insert(schema.punchesTable)
    .values({
      weekStart: startDate,
      kfiId: parsed.data.kfiId,
      customer: parsed.data.customer ?? null,
      source: parsed.data.source,
      date: parsed.data.date,
      clockIn: `${parsed.data.date} ${parsed.data.clockIn}`,
      clockOut: `${parsed.data.date} ${parsed.data.clockOut}`,
      hours: String(hours),
      payType: parsed.data.payType ?? null,
      dispTz,
      isManual: true,
      createdBy: req.session.userId ?? null,
    })
    .returning();
  res.json(serializePunch(row));
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
  if (parsed.data.reviewed) {
    await db
      .insert(schema.reviewedDriversTable)
      .values({
        weekStart,
        kfiId,
        reviewedBy: req.session.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [
          schema.reviewedDriversTable.weekStart,
          schema.reviewedDriversTable.kfiId,
        ],
        set: { reviewedBy: req.session.userId ?? null, reviewedAt: new Date() },
      });
  } else {
    await db
      .delete(schema.reviewedDriversTable)
      .where(
        and(
          eq(schema.reviewedDriversTable.weekStart, weekStart),
          eq(schema.reviewedDriversTable.kfiId, kfiId),
        ),
      );
  }
  res.json({ reviewed: parsed.data.reviewed });
});

function serializePunch(
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
        <th class="num">Overtime</th><th>Reviewed</th>
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

export { serializePunch };
