import { Router, type Request } from "express";
import { asc, eq } from "drizzle-orm";
import {
  GetDriverPayrollProfileResponse,
  UpdateDriverPayrollProfileBody,
  GetZenopleReadinessResponse,
} from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import { requireAuth, requireAdmin } from "../lib/auth.js";
import { sundayOf, weekEndOf } from "../lib/time.js";
import { computeDriverTotals } from "../lib/hoursEngine.js";
import {
  publish as publishRealtime,
  type ActorRef,
} from "../lib/realtime.js";

import {
  buildZenopleWorkbook,
  isoToExcelSerial,
  missingProfileFields,
  zenopleFileName,
  type ZenopleDriverInput,
  type ZenopleProfile,
} from "../lib/zenopleExport.js";

const router = Router();

function profileFromRow(
  row: typeof schema.driverPayrollProfilesTable.$inferSelect | null,
): ZenopleProfile {
  if (!row) {
    return {
      ssn: null,
      jobId: null,
      personId: null,
      assignmentId: null,
      zenopleCustomer: null,
      rtPayRate: null,
      rtBillRate: null,
      otPayRate: null,
      otBillRate: null,
      driverRtPayRate: null,
      driverRtBillRate: null,
      driverOtPayRate: null,
      driverOtBillRate: null,
    };
  }
  const num = (v: string | null): number | null =>
    v == null ? null : Number(v);
  return {
    ssn: row.ssn,
    jobId: row.jobId,
    personId: row.personId,
    assignmentId: row.assignmentId,
    zenopleCustomer: row.zenopleCustomer,
    rtPayRate: num(row.rtPayRate),
    rtBillRate: num(row.rtBillRate),
    otPayRate: num(row.otPayRate),
    otBillRate: num(row.otBillRate),
    driverRtPayRate: num(row.driverRtPayRate),
    driverRtBillRate: num(row.driverRtBillRate),
    driverOtPayRate: num(row.driverOtPayRate),
    driverOtBillRate: num(row.driverOtBillRate),
  };
}

async function loadProfileResponse(kfiId: string) {
  const row =
    (await db.query.driverPayrollProfilesTable.findFirst({
      where: eq(schema.driverPayrollProfilesTable.kfiId, kfiId),
    })) ?? null;
  let updatedByEmail: string | null = null;
  if (row?.updatedBy) {
    const user = await db.query.usersTable.findFirst({
      where: eq(schema.usersTable.id, row.updatedBy),
      columns: { email: true },
    });
    updatedByEmail = user?.email ?? null;
  }
  const p = profileFromRow(row);
  return {
    kfiId,
    ssn: p.ssn,
    jobId: p.jobId,
    personId: p.personId,
    assignmentId: p.assignmentId,
    zenopleCustomer: p.zenopleCustomer,
    rtPayRate: p.rtPayRate,
    rtBillRate: p.rtBillRate,
    otPayRate: p.otPayRate,
    otBillRate: p.otBillRate,
    driverRtPayRate: p.driverRtPayRate,
    driverRtBillRate: p.driverRtBillRate,
    driverOtPayRate: p.driverOtPayRate,
    driverOtBillRate: p.driverOtBillRate,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    updatedByEmail,
  };
}

router.get("/drivers/:kfiId/payroll-profile", requireAuth, async (req, res) => {
  const kfiId = String(req.params.kfiId);
  const driver = await db.query.driversTable.findFirst({
    where: eq(schema.driversTable.kfiId, kfiId),
  });
  if (!driver) {
    res.status(404).json({ error: "Driver not found" });
    return;
  }
  const body = await loadProfileResponse(kfiId);
  const parsed = GetDriverPayrollProfileResponse.safeParse(body);
  if (!parsed.success) {
    req.log.error({ issues: parsed.error.issues }, "payroll profile shape");
    res.status(500).json({ error: "Internal error" });
    return;
  }
  res.json(parsed.data);
});

router.patch(
  "/drivers/:kfiId/payroll-profile",
  requireAdmin,
  async (req, res) => {
    const kfiId = String(req.params.kfiId);
    const driver = await db.query.driversTable.findFirst({
      where: eq(schema.driversTable.kfiId, kfiId),
    });
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const parsed = UpdateDriverPayrollProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }
    const b = parsed.data;
    // numeric() columns accept string or null
    const num = (v: number | null | undefined): string | null =>
      v == null ? null : String(v);
    const values = {
      kfiId: kfiId as string,
      ssn: b.ssn ?? null,
      jobId: b.jobId ?? null,
      personId: b.personId ?? null,
      assignmentId: b.assignmentId ?? null,
      zenopleCustomer: b.zenopleCustomer?.trim() || null,
      rtPayRate: num(b.rtPayRate),
      rtBillRate: num(b.rtBillRate),
      otPayRate: num(b.otPayRate),
      otBillRate: num(b.otBillRate),
      driverRtPayRate: num(b.driverRtPayRate),
      driverRtBillRate: num(b.driverRtBillRate),
      driverOtPayRate: num(b.driverOtPayRate),
      driverOtBillRate: num(b.driverOtBillRate),
      updatedBy: req.session.userId ?? null,
      updatedAt: new Date(),
    };
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.driverPayrollProfilesTable)
        .values(values)
        .onConflictDoUpdate({
          target: schema.driverPayrollProfilesTable.kfiId,
          set: { ...values, kfiId: undefined as unknown as string },
        });
      // Audit-log the rate change so admins can see who touched which driver.
      await tx.insert(schema.userAuditLogTable).values({
        actorUserId: req.session.userId ?? null,
        targetUserId: null,
        targetEmail: `payroll-profile:${kfiId}`,
        action: "payroll-profile-update",
      });
    });
    const actor = (req as Request & { user?: { id: number; email: string } })
      .user;
    publishRealtime({
      type: "payroll-profile",
      kfiId,
      actor: actor ? { userId: actor.id, email: actor.email } : null,
    });
    const body = await loadProfileResponse(kfiId);
    res.json(GetDriverPayrollProfileResponse.parse(body));
  },
);

/**
 * Resolve the (drivers, profiles, punches) inputs the export & readiness
 * checks both need. Drivers are filtered to ones with hours > 0 in the week.
 */
async function loadWeekDriverInputs(weekStart: string): Promise<{
  drivers: Array<{ kfiId: string; name: string }>;
  profiles: Map<string, typeof schema.driverPayrollProfilesTable.$inferSelect>;
  punchesByKfi: Map<string, (typeof schema.punchesTable.$inferSelect)[]>;
}> {
  const punches = await db
    .select()
    .from(schema.punchesTable)
    .where(eq(schema.punchesTable.weekStart, weekStart))
    .orderBy(asc(schema.punchesTable.kfiId));
  const punchesByKfi = new Map<
    string,
    (typeof schema.punchesTable.$inferSelect)[]
  >();
  for (const p of punches) {
    const arr = punchesByKfi.get(p.kfiId) ?? [];
    arr.push(p);
    punchesByKfi.set(p.kfiId, arr);
  }
  const kfiIds = [...punchesByKfi.keys()];
  if (kfiIds.length === 0) {
    return { drivers: [], profiles: new Map(), punchesByKfi };
  }
  const drivers = await db
    .select({
      kfiId: schema.driversTable.kfiId,
      name: schema.driversTable.name,
    })
    .from(schema.driversTable);
  const driverByKfi = new Map(drivers.map((d) => [d.kfiId, d]));
  const profilesArr = await db
    .select()
    .from(schema.driverPayrollProfilesTable);
  const profiles = new Map(profilesArr.map((p) => [p.kfiId, p]));
  // Restrict to drivers that actually had hours this week.
  const activeDrivers = kfiIds
    .map((id) => driverByKfi.get(id))
    .filter((d): d is { kfiId: string; name: string } => Boolean(d));
  return { drivers: activeDrivers, profiles, punchesByKfi };
}

async function computeReadiness(weekStart: string) {
  const sunday = sundayOf(weekStart);
  const endIso = weekEndOf(sunday);
  const { drivers, profiles, punchesByKfi } =
    await loadWeekDriverInputs(sunday);

  // Reviewed status: a driver is "reviewed" when their reviewed_drivers row
  // has status='good'. 'bad' and missing rows both block export.
  const reviewedRows = await db
    .select({
      kfiId: schema.reviewedDriversTable.kfiId,
      status: schema.reviewedDriversTable.status,
    })
    .from(schema.reviewedDriversTable)
    .where(eq(schema.reviewedDriversTable.weekStart, sunday));
  const reviewedGood = new Set(
    reviewedRows.filter((r) => r.status === "good").map((r) => r.kfiId),
  );

  const unreviewed: string[] = [];
  const missingProfile: Array<{
    kfiId: string;
    name: string;
    missing: string[];
  }> = [];

  for (const d of drivers) {
    const punches = punchesByKfi.get(d.kfiId) ?? [];
    const totals = computeDriverTotals(punches);
    const hours =
      totals.custRt + totals.custOt + totals.driverRt + totals.driverOt;
    if (hours <= 0) continue;
    if (!reviewedGood.has(d.kfiId)) unreviewed.push(d.kfiId);
    const profile = profiles.get(d.kfiId)
      ? profileFromRow(profiles.get(d.kfiId)!)
      : null;
    const missing = missingProfileFields(profile);
    // Driver-only rows don't need RT/OT pair, vice versa — but the simpler,
    // safer rule is "all fields must be present" so admins set up profiles
    // deliberately. Strict-mode is what the task spec asks for.
    if (missing.length > 0) {
      missingProfile.push({ kfiId: d.kfiId, name: d.name, missing });
    }
  }

  const driversTotal = drivers.filter((d) => {
    const punches = punchesByKfi.get(d.kfiId) ?? [];
    const t = computeDriverTotals(punches);
    return t.custRt + t.custOt + t.driverRt + t.driverOt > 0;
  }).length;
  const driversReady = driversTotal - unreviewed.length - missingProfile.length;

  return {
    ready: unreviewed.length === 0 && missingProfile.length === 0,
    weekEnd: endIso,
    ppe: isoToExcelSerial(endIso),
    driversTotal,
    driversReady: Math.max(driversReady, 0),
    unreviewedKfiIds: unreviewed,
    missingProfileKfiIds: missingProfile,
  };
}

router.get(
  "/weeks/:weekStart/zenople-readiness",
  requireAdmin,
  async (req, res) => {
    const weekStart = String(req.params.weekStart);
    const readiness = await computeReadiness(weekStart);
    res.json(GetZenopleReadinessResponse.parse(readiness));
  },
);

router.get(
  "/weeks/:weekStart/zenople-export",
  requireAdmin,
  async (req, res) => {
    const weekStart = String(req.params.weekStart);
    const sunday = sundayOf(weekStart);
    const readiness = await computeReadiness(sunday);
    if (!readiness.ready) {
      res.status(409).json(GetZenopleReadinessResponse.parse(readiness));
      return;
    }
    const { drivers, profiles, punchesByKfi } =
      await loadWeekDriverInputs(sunday);
    const inputs: ZenopleDriverInput[] = drivers
      .map((d) => ({
        kfiId: d.kfiId,
        name: d.name,
        zenopleName: null,
        profile: profileFromRow(profiles.get(d.kfiId) ?? null),
        punches: punchesByKfi.get(d.kfiId) ?? [],
      }))
      // Drop drivers with no hours so we don't emit empty rows.
      .filter((d) => {
        const t = computeDriverTotals(d.punches);
        return t.custRt + t.custOt + t.driverRt + t.driverOt > 0;
      });
    const endIso = readiness.weekEnd;
    const buffer = buildZenopleWorkbook(inputs, endIso);
    const fileName = zenopleFileName(new Date(), endIso);

    // Audit the export so admins can see who exported what.
    await db.insert(schema.userAuditLogTable).values({
      actorUserId: req.session.userId ?? null,
      targetUserId: null,
      targetEmail: `zenople-export:${sunday}`,
      action: "export-zenople",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName.replace(/"/g, "")}"`,
    );
    res.send(buffer);
  },
);

export const payrollRouter = router;
