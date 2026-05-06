import { Router } from "express";
import { eq } from "drizzle-orm";
import { EditPunchBody } from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { serializePunch } from "./weeks.js";
import { diffHours } from "../lib/time.js";

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
  const newIn = parsed.data.clockIn ?? existing.clockIn;
  const newOut = parsed.data.clockOut ?? existing.clockOut;
  const hours = diffHours(newIn, newOut);
  const [row] = await db
    .update(schema.punchesTable)
    .set({
      clockIn: newIn,
      clockOut: newOut,
      hours: String(Math.round(hours * 1000) / 1000),
      edited: true,
    })
    .where(eq(schema.punchesTable.id, id))
    .returning();
  res.json(serializePunch(row));
});

punchesRouter.delete("/punches/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(schema.punchesTable).where(eq(schema.punchesTable.id, id));
  res.status(204).end();
});
