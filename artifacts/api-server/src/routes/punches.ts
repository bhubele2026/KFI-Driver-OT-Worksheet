import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { EditPunchBody } from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { assertNotLocked } from "../lib/locks.js";
import { serializePunch } from "./weeks.js";
import { diffHours } from "../lib/time.js";
import { publish as publishRealtime, type ActorRef } from "../lib/realtime.js";

function actorRef(req: import("express").Request): ActorRef | null {
  const user = (req as import("express").Request & { user?: { id: number; email: string } }).user;
  if (user) return { userId: user.id, email: user.email };
  return null;
}

async function loadEmailsForPunch(
  p: typeof schema.punchesTable.$inferSelect,
): Promise<Map<number, string>> {
  const ids = new Set<number>();
  if (p.createdBy) ids.add(p.createdBy);
  if (p.updatedBy) ids.add(p.updatedBy);
  if (p.reviewedBy) ids.add(p.reviewedBy);
  if (ids.size === 0) return new Map();
  const rows = await db
    .select({ id: schema.usersTable.id, email: schema.usersTable.email })
    .from(schema.usersTable)
    .where(inArray(schema.usersTable.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.email]));
}

export const punchesRouter = Router();

punchesRouter.use(requireAuth);

punchesRouter.patch("/punches/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = EditPunchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const existing = await db.query.punchesTable.findFirst({
    where: eq(schema.punchesTable.id, id),
  });
  if (!existing) {
    res.status(404).json({ error: "Punch not found" });
    return;
  }
  if (!(await assertNotLocked(res, existing.weekStart, existing.kfiId))) return;
  // Inline-edit on the driver page sends just a time ("7:30 AM"); the
  // dialog and tests send a fully-prefixed wall-clock string. Either way,
  // re-anchor against the existing punch's date so we always store a
  // string the hours engine can parse.
  const prefix = (s: string | null | undefined): string => {
    if (!s) return s ?? "";
    if (/^\d{4}-\d{2}-\d{2}\s/.test(s)) return s;
    return `${existing.date} ${s.trim()}`;
  };
  const newIn = prefix(parsed.data.clockIn ?? existing.clockIn);
  const newOut = prefix(parsed.data.clockOut ?? existing.clockOut);
  const hours = diffHours(newIn, newOut);
  // Auto-clear the per-punch reviewed flag when content actually changed.
  // A pure no-op edit (same in/out) preserves the existing reviewed mark
  // so an accidental save doesn't force a re-tick.
  const contentChanged =
    newIn !== existing.clockIn || newOut !== existing.clockOut;
  const [row] = await db
    .update(schema.punchesTable)
    .set({
      clockIn: newIn,
      clockOut: newOut,
      hours: String(Math.round(hours * 100) / 100),
      edited: true,
      updatedBy: req.session.userId ?? null,
      ...(contentChanged
        ? { reviewedAt: null, reviewedBy: null }
        : {}),
    })
    .where(eq(schema.punchesTable.id, id))
    .returning();
  publishRealtime({
    type: "punch-changed",
    weekStart: row.weekStart,
    kfiId: row.kfiId,
    action: "update",
    punchId: row.id,
    actor: actorRef(req),
  });
  const emails = await loadEmailsForPunch(row);
  res.json(serializePunch(row, emails));
});

punchesRouter.delete("/punches/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const existing = await db.query.punchesTable.findFirst({
    where: eq(schema.punchesTable.id, id),
  });
  if (!existing) {
    res.status(204).end();
    return;
  }
  if (!(await assertNotLocked(res, existing.weekStart, existing.kfiId))) return;
  // Record the delete in punch_deletions before hard-deleting so admins
  // can still attribute the action during reconciliation disputes.
  await db.transaction(async (tx) => {
    await tx.insert(schema.punchDeletionsTable).values({
      punchId: existing.id,
      weekStart: existing.weekStart,
      kfiId: existing.kfiId,
      customer: existing.customer,
      source: existing.source,
      deletedBy: req.session.userId ?? null,
    });
    await tx
      .delete(schema.punchesTable)
      .where(eq(schema.punchesTable.id, id));
  });
  publishRealtime({
    type: "punch-changed",
    weekStart: existing.weekStart,
    kfiId: existing.kfiId,
    action: "delete",
    punchId: existing.id,
    actor: actorRef(req),
  });
  res.status(204).end();
});

punchesRouter.put("/punches/:id/reviewed", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = req.body as { reviewed?: unknown } | undefined;
  if (!body || typeof body.reviewed !== "boolean") {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const reviewed = body.reviewed;
  const existing = await db.query.punchesTable.findFirst({
    where: eq(schema.punchesTable.id, id),
  });
  if (!existing) {
    res.status(404).json({ error: "Punch not found" });
    return;
  }
  if (!(await assertNotLocked(res, existing.weekStart, existing.kfiId))) return;
  const userId = req.session.userId ?? null;
  const [row] = await db
    .update(schema.punchesTable)
    .set(
      reviewed
        ? { reviewedAt: new Date(), reviewedBy: userId }
        : { reviewedAt: null, reviewedBy: null },
    )
    .where(eq(schema.punchesTable.id, id))
    .returning();
  publishRealtime({
    type: "punch-changed",
    weekStart: row.weekStart,
    kfiId: row.kfiId,
    action: "reviewed",
    punchId: row.id,
    actor: actorRef(req),
  });
  const emails = await loadEmailsForPunch(row);
  res.json(serializePunch(row, emails));
});
