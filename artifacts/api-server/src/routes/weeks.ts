import { Router } from "express";
import multer from "multer";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  CreateManualPunchBody,
  SetReviewedBody,
} from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import {
  fetchAllUsers,
  fetchPunchesForWeek,
} from "../lib/connecteam.js";
import {
  computeChecks,
  computeDailyTotals,
  computeDriverTotals,
  defaultDispTz,
} from "../lib/hoursEngine.js";
import { detectAndParseFile } from "../lib/parsers/index.js";
import { addDays, mondayOf, weekEndOf } from "../lib/time.js";

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
    });
  }
  rows.sort(
    (a, b) =>
      a.customer.localeCompare(b.customer) || a.name.localeCompare(b.name),
  );
  const customers = [...new Set(rows.map((r) => r.customer))]
    .sort()
    .map((customer) => ({
      customer,
      drivers: rows.filter((r) => r.customer === customer),
    }));

  res.json({
    startDate: weekStart,
    endDate,
    lastRefreshedAt: week?.lastRefreshedAt ?? null,
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
    punches: punches.map(serializePunch),
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
      await tx
        .delete(schema.punchesTable)
        .where(
          and(
            eq(schema.punchesTable.weekStart, startDate),
            eq(schema.punchesTable.source, "Driver"),
            eq(schema.punchesTable.isManual, false),
          ),
        );
      if (dedupedPunches.length > 0) {
        await tx.insert(schema.punchesTable).values(
          dedupedPunches.map((p) => ({
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
        .set({ lastRefreshedAt: refreshedAt })
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
    let result;
    try {
      result = await detectAndParseFile(
        req.file.originalname,
        req.file.buffer,
        kfiSet,
        startDate,
      );
    } catch (err) {
      req.log.error({ err, fileName: req.file.originalname }, "Parse error");
      res.status(400).json({
        error: err instanceof Error ? err.message : "Could not parse file",
      });
      return;
    }
    if (!result || result.punches.length === 0) {
      res.status(400).json({
        error:
          "Could not detect customer from filename. Include the customer name (penda, trienda, greystone, lsi, burnett, adient, iwg, delallo, zenople) in the file name.",
      });
      return;
    }
    // Transactional swap: delete the existing customer-source rows for this
    // (week, customer) and insert the new batch atomically.
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.punchesTable)
        .where(
          and(
            eq(schema.punchesTable.weekStart, startDate),
            eq(schema.punchesTable.source, "Customer"),
            eq(schema.punchesTable.customer, result.customer),
            eq(schema.punchesTable.isManual, false),
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
    res.json({
      customer: result.customer,
      fileName: req.file.originalname,
      punchesUpserted: result.punches.length,
    });
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

// Avoid unused import if `addDays` ever becomes unused after refactor.
void addDays;

function serializePunch(p: typeof schema.punchesTable.$inferSelect) {
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
  };
}

export { serializePunch };
