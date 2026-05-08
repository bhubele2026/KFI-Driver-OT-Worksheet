import { and, eq, sql } from "drizzle-orm";
import type { Response } from "express";
import { db, schema } from "./db.js";

// A driver-week is "locked" when its reviewed_drivers row has lockedAt non-null.
// Locking freezes the driver-week: Connecteam refresh, customer-file uploads,
// confirm-new-customer, manual punch entry, and PATCH/DELETE on punches all
// return 423 for that (week, kfiId).

export async function isDriverWeekLocked(
  weekStart: string,
  kfiId: string,
): Promise<boolean> {
  const row = await db.query.reviewedDriversTable.findFirst({
    where: and(
      eq(schema.reviewedDriversTable.weekStart, weekStart),
      eq(schema.reviewedDriversTable.kfiId, kfiId),
      sql`${schema.reviewedDriversTable.lockedAt} IS NOT NULL`,
    ),
  });
  return !!row;
}

// Sends a 423 response and returns false when locked. Returns true when the
// route may continue. Centralizes the 423 wire format so the frontend can
// rely on a consistent error shape.
export async function assertNotLocked(
  res: Response,
  weekStart: string,
  kfiId: string,
): Promise<boolean> {
  if (await isDriverWeekLocked(weekStart, kfiId)) {
    res.status(423).json({
      error: `Driver ${kfiId} is locked for week ${weekStart}. Unlock it before making changes.`,
      locked: true,
      weekStart,
      kfiId,
    });
    return false;
  }
  return true;
}

export async function loadLockedKfiIds(weekStart: string): Promise<Set<string>> {
  const rows = await db
    .select({ kfiId: schema.reviewedDriversTable.kfiId })
    .from(schema.reviewedDriversTable)
    .where(
      and(
        eq(schema.reviewedDriversTable.weekStart, weekStart),
        sql`${schema.reviewedDriversTable.lockedAt} IS NOT NULL`,
      ),
    );
  return new Set(rows.map((r) => r.kfiId));
}
