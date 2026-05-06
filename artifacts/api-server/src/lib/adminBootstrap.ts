import { and, asc, count, eq, sql } from "drizzle-orm";
import { db, schema } from "./db.js";
import { logger } from "./logger.js";

// Ensures at least one active admin exists after the isAdmin/isActive
// migration; promotes (and reactivates if needed) the oldest user.
export async function ensureAtLeastOneAdmin(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${schema.usersTable} IN EXCLUSIVE MODE`);
    const [{ n: total }] = await tx
      .select({ n: count() })
      .from(schema.usersTable);
    if (Number(total) === 0) return;
    const [{ n: activeAdmins }] = await tx
      .select({ n: count() })
      .from(schema.usersTable)
      .where(
        and(
          eq(schema.usersTable.isAdmin, true),
          eq(schema.usersTable.isActive, true),
        ),
      );
    if (Number(activeAdmins) > 0) return;
    const candidate =
      (
        await tx
          .select()
          .from(schema.usersTable)
          .where(eq(schema.usersTable.isActive, true))
          .orderBy(asc(schema.usersTable.createdAt))
          .limit(1)
      )[0] ??
      (
        await tx
          .select()
          .from(schema.usersTable)
          .orderBy(asc(schema.usersTable.createdAt))
          .limit(1)
      )[0];
    if (!candidate) return;
    await tx
      .update(schema.usersTable)
      .set({ isAdmin: true, isActive: true })
      .where(eq(schema.usersTable.id, candidate.id));
    logger.warn(
      { userId: candidate.id, email: candidate.email },
      "no active admin found; promoted oldest user to admin to keep admin flows reachable",
    );
  });
}
