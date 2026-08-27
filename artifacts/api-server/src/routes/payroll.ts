import { Router, type Request } from "express";
import { asc, eq } from "drizzle-orm";
import {
  GetDriverPayrollProfileResponse,
  UpdateDriverPayrollProfileBody,
  GetZenopleReadinessResponse,
} from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import { requireAuth, requireAdmin } from "../lib/auth.js";
import { requireTile } from "../lib/entraAuth.js";
import { sundayOf, weekEndOf } from "../lib/time.js";
import { computeDriverTotals } from "../lib/hoursEngine.js";
import {
  publish as publishRealtime,
  type ActorRef,
} from "../lib/realtime.js";

import {
  buildExportSnapshot,
  buildZenopleRows,
  isoToExcelSerial,
  mergeProfileWithLive,
  missingProfileFields,
  workbookFromRows,
  zenopleFileName,
  type ZenopleDriverInput,
  type ZenopleProfile,
} from "../lib/zenopleExport.js";
import * as Sentry from "@sentry/node";
import {
  loadZenopleExportFacts,
  type ZenopleLiveFacts,
} from "../lib/zenopleRates.js";

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
    // True partial update (the verb is PATCH): only fields present in the
    // body are written. An explicit null clears a field; an omitted field
    // is left untouched — a rates-only call must not wipe SSN/ids.
    const patch: Partial<typeof schema.driverPayrollProfilesTable.$inferInsert> = {};
    if (b.ssn !== undefined) patch.ssn = b.ssn ?? null;
    if (b.jobId !== undefined) patch.jobId = b.jobId ?? null;
    if (b.personId !== undefined) patch.personId = b.personId ?? null;
    if (b.assignmentId !== undefined) patch.assignmentId = b.assignmentId ?? null;
    if (b.zenopleCustomer !== undefined)
      patch.zenopleCustomer = b.zenopleCustomer?.trim() || null;
    if (b.rtPayRate !== undefined) patch.rtPayRate = num(b.rtPayRate);
    if (b.rtBillRate !== undefined) patch.rtBillRate = num(b.rtBillRate);
    if (b.otPayRate !== undefined) patch.otPayRate = num(b.otPayRate);
    if (b.otBillRate !== undefined) patch.otBillRate = num(b.otBillRate);
    if (b.driverRtPayRate !== undefined)
      patch.driverRtPayRate = num(b.driverRtPayRate);
    if (b.driverRtBillRate !== undefined)
      patch.driverRtBillRate = num(b.driverRtBillRate);
    if (b.driverOtPayRate !== undefined)
      patch.driverOtPayRate = num(b.driverOtPayRate);
    if (b.driverOtBillRate !== undefined)
      patch.driverOtBillRate = num(b.driverOtBillRate);
    patch.updatedBy = req.session.userId ?? null;
    patch.updatedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.driverPayrollProfilesTable)
        .values({ kfiId: kfiId as string, ...patch })
        .onConflictDoUpdate({
          target: schema.driverPayrollProfilesTable.kfiId,
          set: patch,
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

export async function computeReadiness(weekStart: string) {
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
    // Only the five identity fields block readiness (ssn, jobId, personId,
    // assignmentId, zenopleCustomer). Rate fields default to $0 in the
    // export when null — see `missingProfileFields` for the rationale.
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
  requireTile("timesheets"),
  async (req, res) => {
    const weekStart = String(req.params.weekStart);
    const readiness = await computeReadiness(weekStart);
    res.json(GetZenopleReadinessResponse.parse(readiness));
  },
);

router.get(
  "/weeks/:weekStart/zenople-export",
  requireAdmin,
  requireTile("timesheets"),
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
    // Live Zenople facts win field-by-field over the stored profile —
    // Zenople's rates/ids drift week to week and this workbook is imported
    // back into Zenople. Profile-only (with a loud log) when the API is
    // unreachable or unconfigured.
    // Cached for ten minutes (see loadZenopleExportFacts); `?fresh=1` re-pulls
    // for the case where a rate has just been corrected in Zenople.
    const fresh = String(req.query.fresh ?? "") === "1";
    let liveFacts = new Map<string, ZenopleLiveFacts>();
    try {
      liveFacts = await loadZenopleExportFacts(fresh);
    } catch (err) {
      req.log.warn(
        { err },
        "zenople-export: live Zenople fetch failed — exporting from stored profiles only",
      );
    }
    // The stored PersonId is the pin: it says WHICH Zenople human this driver
    // is, so rates and the Person label must follow it rather than a kfi_id
    // that may or may not be a Zenople person id. Falls back to kfi_id (real
    // badge ids ARE Zenople person ids) when nothing is pinned yet.
    const factsFor = (
      kfiId: string,
      profile: ZenopleProfile,
    ): ZenopleLiveFacts | undefined =>
      (profile.personId != null
        ? liveFacts.get(String(profile.personId))
        : undefined) ?? liveFacts.get(kfiId);
    const inputs: ZenopleDriverInput[] = drivers
      .map((d) => {
        const stored = profileFromRow(profiles.get(d.kfiId) ?? null);
        const live = factsFor(d.kfiId, stored);
        return {
          kfiId: d.kfiId,
          name: d.name,
          zenopleName: live?.personLabel ?? null,
          profile: mergeProfileWithLive(stored, live),
          punches: punchesByKfi.get(d.kfiId) ?? [],
        };
      })
      // Drop drivers with no hours so we don't emit empty rows.
      .filter((d) => {
        const t = computeDriverTotals(d.punches);
        return t.custRt + t.custOt + t.driverRt + t.driverOt > 0;
      });
    req.log.info(
      {
        weekStart: sunday,
        drivers: inputs.length,
        liveFactsLoaded: liveFacts.size,
        liveMatched: inputs.filter((i) => factsFor(i.kfiId, i.profile)).length,
      },
      "zenople-export: live-merge summary",
    );
    // PPE is the week's Saturday for every customer (uniform since PD 07.24).
    const rows = buildZenopleRows(inputs, sunday);
    const buffer = workbookFromRows(rows);
    const fileName = zenopleFileName(new Date(), readiness.weekEnd);

    // Persist exactly what went into the workbook (rates were merged live,
    // so this snapshot is the only durable record of what Zenople was
    // sent). Best-effort: a snapshot failure must not block the download,
    // but it must not go quiet either.
    try {
      const snap = buildExportSnapshot(rows);
      await db.insert(schema.exportSnapshotsTable).values({
        weekStart: sunday,
        ppe: readiness.ppe,
        exportedBy: req.session.userId ?? null,
        rowCount: snap.rowCount,
        driverCount: snap.driverCount,
        totals: snap.totals,
        rows: snap.rows,
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { feature: "zenople-export", outcome: "snapshot-write-failed" },
        extra: { weekStart: sunday },
      });
      req.log.error({ err, weekStart: sunday }, "export snapshot write failed");
    }

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
