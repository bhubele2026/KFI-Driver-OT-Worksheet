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
import { overriddenRateFields, resolveProfile } from "../lib/rateResolution.js";

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

/**
 * The card's payload. The eight top-level rate fields are the EFFECTIVE rates
 * — what the workbook will actually ship — so the card can no longer show a
 * number the export disagrees with. The saved row rides alongside under
 * `stored`, because the Edit form must seed from that: PATCH is a full
 * replace, so seeding the form from `effective` would let one Save silently
 * freeze today's live Zenople rate as a permanent override on every driver.
 *
 * `weekStart` picks the week rates resolve as-of. Without it the card falls
 * back to the stored row rather than guessing a week.
 */
async function loadProfileResponse(kfiId: string, week?: { start: string; end: string }, log?: { warn: (o: unknown, m: string) => void }) {
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
  const stored = profileFromRow(row);
  // Shares the ten-minute memo with the export, so the first card opened in a
  // window pays the Zenople pull and the rest are free. A failure degrades to
  // the stored row — never blocks the card.
  let live: ZenopleLiveFacts | undefined;
  if (week) {
    try {
      const facts = await loadZenopleExportFacts({ week });
      live =
        (stored.personId != null ? facts.get(String(stored.personId)) : undefined) ??
        facts.get(kfiId);
    } catch (err) {
      log?.warn({ err }, "payroll-profile: live Zenople fetch failed — showing stored rates");
    }
  }
  const resolved = resolveProfile(stored, live);
  const p = resolved.effective;
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
    stored: {
      rtPayRate: stored.rtPayRate,
      rtBillRate: stored.rtBillRate,
      otPayRate: stored.otPayRate,
      otBillRate: stored.otBillRate,
      driverRtPayRate: stored.driverRtPayRate,
      driverRtBillRate: stored.driverRtBillRate,
      driverOtPayRate: stored.driverOtPayRate,
      driverOtBillRate: stored.driverOtBillRate,
    },
    provenance: resolved.provenance,
    overriddenRateFields: overriddenRateFields(resolved),
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
  const weekStartRaw = String(req.query.weekStart ?? "").trim();
  const week = weekStartRaw
    ? { start: sundayOf(weekStartRaw), end: weekEndOf(sundayOf(weekStartRaw)) }
    : undefined;
  const body = await loadProfileResponse(kfiId, week, req.log);
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
    // ⚠️ The week is passed in so rates resolve AS-OF the week being paid: an
    // assignment that started after it closed must not supply the rate, and
    // actuals must come from the pay period that week fell in rather than a
    // year-long blend across every raise.
    const fresh = String(req.query.fresh ?? "") === "1";
    const rateWeek = { start: sunday, end: readiness.weekEnd };
    let liveFacts = new Map<string, ZenopleLiveFacts>();
    try {
      liveFacts = await loadZenopleExportFacts({ week: rateWeek, fresh });
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
          profile: resolveProfile(stored, live).effective,
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
